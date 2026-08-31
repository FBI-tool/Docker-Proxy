package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testConfigWithSecret() *Config {
	enabled := true
	return &Config{
		Registries: []RegistryConfig{{
			Name:     "ghcr",
			Hosts:    []string{"ghcr.example.com"},
			Upstream: "https://ghcr.io",
			Auth: AuthConfig{
				Type:     AuthToken,
				Username: "example-user",
				Password: "super-secret-token",
			},
			Enabled: &enabled,
		}},
	}
}

func TestHandleAdminConfigAlwaysMasksPasswords(t *testing.T) {
	proxy := NewProxy(testConfigWithSecret())
	request := httptest.NewRequest(http.MethodGet, "/-/config?include_secrets=1", nil)
	recorder := httptest.NewRecorder()

	handleAdminConfig(recorder, request, proxy, "", "admin-token")

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", recorder.Code)
	}
	if strings.Contains(recorder.Body.String(), "super-secret-token") {
		t.Fatal("include_secrets=1 must not return a plaintext password")
	}

	var response Config
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got := response.Registries[0].Auth.Password; got != adminPasswordSentinel {
		t.Fatalf("expected masked password %q, got %q", adminPasswordSentinel, got)
	}
	if got := proxy.cfg.Registries[0].Auth.Password; got != "super-secret-token" {
		t.Fatalf("masking the response must not mutate the live config, got %q", got)
	}
}

func TestHandleAdminCredentialsReturnsEncryptedPayload(t *testing.T) {
	const adminToken = "admin-token"
	proxy := NewProxy(testConfigWithSecret())
	request := httptest.NewRequest(http.MethodGet, "/-/credentials", nil)
	recorder := httptest.NewRecorder()

	handleAdminCredentials(recorder, request, proxy, adminToken)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", recorder.Code)
	}
	if strings.Contains(recorder.Body.String(), "super-secret-token") {
		t.Fatal("credential sync response must not contain a plaintext password")
	}

	var response credentialSyncResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Algorithm != "AES-256-GCM" {
		t.Fatalf("unexpected algorithm: %s", response.Algorithm)
	}

	sealed, err := base64.StdEncoding.DecodeString(response.Payload)
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	block, err := aes.NewCipher(credentialSyncKey(adminToken))
	if err != nil {
		t.Fatalf("create cipher: %v", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("create gcm: %v", err)
	}
	nonce := sealed[:gcm.NonceSize()]
	ciphertext := sealed[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		t.Fatalf("decrypt payload: %v", err)
	}
	if !bytes.Contains(plaintext, []byte("super-secret-token")) {
		t.Fatal("decrypted credential payload should contain the configured password")
	}
}

func TestCredentialSyncPayloadCannotBeDecryptedWithAnotherToken(t *testing.T) {
	response, err := encryptCredentialSyncPayload(
		testConfigWithSecret().Registries,
		"admin-token",
	)
	if err != nil {
		t.Fatalf("encrypt payload: %v", err)
	}
	sealed, err := base64.StdEncoding.DecodeString(response.Payload)
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}

	wrongKey := sha256.Sum256([]byte("wrong-token"))
	block, err := aes.NewCipher(wrongKey[:])
	if err != nil {
		t.Fatalf("create cipher: %v", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("create gcm: %v", err)
	}
	_, err = gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], nil)
	if err == nil {
		t.Fatal("payload must not decrypt with a different admin token")
	}
}
