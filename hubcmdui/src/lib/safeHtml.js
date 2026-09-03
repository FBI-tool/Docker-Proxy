/**
 * 极简 HTML sanitizer（浏览器侧）。
 *
 * 背景：Landing.vue 会对外部仓库抓取的"镜像描述"和后端"文档 markdown"
 * 的渲染结果使用 v-html，而项目又尚未引入 DOMPurify 依赖。
 * 仓库本身提供的镜像描述、markded 解析出的 HTML 都是可控但不完全可信
 * （镜像描述可能来自 Docker Hub 第三方账户，文档来自后端管理员编辑），
 * 直接 v-html 等于把 XSS 暴露给上游供应链。
 *
 * 本模块不依赖任何第三方包，使用浏览器内置的 DOMParser + TreeWalker 完成
 * 黑名单清洗：
 *   - 删除 <script> / <iframe> / <object> / <embed> / <style> / <link>
 *     / <meta> / <form> / <input> / <button> / <textarea> / <select> /
 *     <option> / <base> / <frame> / <frameset> / <svg> / <math> 等高危元素
 *   - 删除所有 on* 事件属性
 *   - 删除 href / src / xlink:href / action / formaction 中的
 *     javascript: / data: / vbscript: 协议
 *   - 给所有 <a> 强制加上 rel="noopener noreferrer" target="_blank"
 *
 * 使用：
 *   import { sanitizeHtml } from '@/lib/safeHtml'
 *   <div v-html="sanitizeHtml(renderMd(raw))"></div>
 */

const BLOCKED_TAGS = new Set([
  'SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'STYLE', 'LINK', 'META',
  'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'OPTION',
  'BASE', 'FRAME', 'FRAMESET', 'NOSCRIPT', 'SVG', 'MATH', 'TEMPLATE',
  'DETAILS', 'AUDIO', 'VIDEO', 'SOURCE', 'TRACK'
])

// href / src / xlink:href / action / formaction 等 URL 类属性的危险协议
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'background', 'data'])

function isDangerousUrl(value) {
  if (!value) return false
  const v = String(value).trim()
  if (!v) return false
  return /^(javascript|vbscript|file):/i.test(v) ||
    /^data:text\/html/i.test(v) ||
    /^data:application\/javascript/i.test(v)
}

function isDangerousAttr(name) {
  if (!name) return false
  if (/^on/i.test(name)) return true
  if (name.toLowerCase() === 'srcdoc') return true
  return false
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 全功能 sanitize：浏览器侧 DOM 解析 + 黑名单清洗；非浏览器侧
 * 降级为纯文本转义。
 */
export function sanitizeHtml(input) {
  const html = String(input == null ? '' : input)
  if (!html) return ''
  if (typeof DOMParser === 'undefined') {
    // 非浏览器环境（Node SSR / 测试）：保守降级，把所有 HTML 都当文本输出
    return escapeHtml(html)
  }
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    if (!doc || !doc.body) return ''
    const all = doc.body.querySelectorAll('*')
    all.forEach((el) => {
      const tag = (el.tagName || '').toUpperCase()
      if (BLOCKED_TAGS.has(tag)) {
        el.remove()
        return
      }
      // 属性清洗
      const removeAttrs = []
      for (const attr of [...el.attributes]) {
        if (isDangerousAttr(attr.name)) {
          removeAttrs.push(attr.name)
          continue
        }
        if (URL_ATTRS.has(attr.name.toLowerCase()) && isDangerousUrl(attr.value)) {
          removeAttrs.push(attr.name)
          continue
        }
      }
      removeAttrs.forEach((n) => el.removeAttribute(n))
      // 给所有 <a> 强制加安全属性
      if (tag === 'A') {
        el.setAttribute('rel', 'noopener noreferrer')
        if (!el.getAttribute('target')) el.setAttribute('target', '_blank')
      }
    })
    return doc.body.innerHTML
  } catch {
    return escapeHtml(html)
  }
}

export default sanitizeHtml
