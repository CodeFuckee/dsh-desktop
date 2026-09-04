/**
 * dsh-desktop shell UI.
 *
 * Two states:
 *   - starting (default): shown while the Rust host boots `dsh web`.
 *   - error: activated by the host through `window.__dshDesktopError(payload)`.
 *
 * The host navigates the webview to the dsh web URL once it is ready, so this
 * page never renders the harness itself — it only bridges startup and failure.
 */
'use strict'

const starting = document.getElementById('view-starting')
const errorView = document.getElementById('view-error')
const errorSummary = document.getElementById('error-summary')
const errorDetail = document.getElementById('error-detail')
const closeButton = document.getElementById('error-close')

/** Called by the Rust host: switch to the error view with a readable message. */
window.__dshDesktopError = (payload) => {
  const data = typeof payload === 'string' ? JSON.parse(payload) : payload
  const summary = data?.summary ?? 'DeepSeek Harness 本地服务未能启动。'
  const detail = data?.detail ?? ''
  const exitCode = data?.exitCode
  const detailLines = []
  if (exitCode !== undefined && exitCode !== null) {
    detailLines.push(`进程退出码：${exitCode}`)
  }
  if (detail.length > 0) {
    detailLines.push('--- 服务输出（末尾） ---')
    detailLines.push(detail)
  }
  errorSummary.textContent = summary
  errorDetail.textContent = detailLines.join('\n')
  starting.classList.add('hidden')
  errorView.classList.remove('hidden')
}

closeButton.addEventListener('click', () => {
  // The host shuts the server down when the window closes.
  window.close()
})