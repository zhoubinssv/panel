const logger = require('../services/logger');

/**
 * 统一 API JSON 错误响应格式
 * { ok: false, error: "消息", code: "ERROR_CODE" }
 */

// 404 处理
function notFoundHandler(req, res) {
  const isApi = req.path.startsWith('/admin/api') || req.headers.accept?.includes('json');
  if (isApi) {
    return res.status(404).json({ ok: false, error: '接口不存在', code: 'NOT_FOUND' });
  }
  res.status(404).send(`
    <!DOCTYPE html><html><head><meta charset="UTF-8"><title>404 · 小姨子的诱惑</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🍑</text></svg>">
    <link rel="stylesheet" href="/css/tailwind.min.css"></head>
    <body class="bg-[#0c0a0f] min-h-screen flex items-center justify-center">
      <div class="text-center">
        <p class="text-5xl mb-3">🍑</p>
        <p class="text-6xl mb-4">🫥</p>
        <h1 class="text-white text-2xl font-bold mb-2">页面不存在</h1>
        <a href="/" class="text-rose-400 hover:underline">返回首页</a>
      </div>
    </body></html>
  `);
}

// 全局错误处理
function errorHandler(err, req, res, _next) {
  logger.error({ err, path: req.path, method: req.method }, '请求处理错误');

  const status = err.status || err.statusCode || 500;
  const isApi = req.path.startsWith('/admin/api') || req.headers.accept?.includes('json');

  if (isApi) {
    return res.status(status).json({
      ok: false,
      error: status === 500 ? '服务器内部错误' : (err.message || '请求失败'),
      code: err.code || 'INTERNAL_ERROR'
    });
  }

  res.status(status).send(`
    <!DOCTYPE html><html><head><meta charset="UTF-8"><title>${status} · 小姨子的诱惑</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🍑</text></svg>">
    <link rel="stylesheet" href="/css/tailwind.min.css"></head>
    <body class="bg-[#0c0a0f] min-h-screen flex items-center justify-center">
      <div class="text-center">
        <p class="text-5xl mb-3">🍑</p>
        <p class="text-6xl mb-4">💥</p>
        <h1 class="text-white text-2xl font-bold mb-2">服务器开小差了</h1>
        <p class="text-gray-400 mb-4">请稍后再试</p>
        <a href="/" class="text-rose-400 hover:underline">返回首页</a>
      </div>
    </body></html>
  `);
}

module.exports = { notFoundHandler, errorHandler };
