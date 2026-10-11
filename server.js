const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const projectRoot = __dirname;
const maxRequestBytes = 24 * 1024;
const requestWindowMs = 60_000;
const maxRequestsPerWindow = 15;
const rateLimits = new Map();

function loadEnvFile() {
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || line.trimStart().startsWith('#')) continue;

    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] ??= value;
  }
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(data));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxRequestBytes) {
      const error = new Error('Request body too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

function isRateLimited(ipAddress) {
  const now = Date.now();
  let entry = rateLimits.get(ipAddress);

  if (!entry || now - entry.startedAt >= requestWindowMs) {
    entry = { startedAt: now, count: 0 };
  }
  if (entry.count >= maxRequestsPerWindow) {
    rateLimits.set(ipAddress, entry);
    return true;
  }

  entry.count += 1;
  rateLimits.set(ipAddress, entry);

  if (rateLimits.size > 1_000) {
    for (const [key, value] of rateLimits) {
      if (now - value.startedAt >= requestWindowMs) rateLimits.delete(key);
    }
  }
  return false;
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .slice(-12)
    .filter(message => message && (message.role === 'user' || message.role === 'model'))
    .map(message => ({
      role: message.role,
      text: typeof message.text === 'string' ? message.text.trim().slice(0, 1_500) : ''
    }))
    .filter(message => message.text.length > 0);
}

function cleanProducts(products) {
  if (!Array.isArray(products)) return [];

  return products.slice(0, 30).flatMap(product => {
    if (!product || typeof product.name !== 'string' || typeof product.category !== 'string') return [];

    const price = Number(product.price);
    if (!Number.isFinite(price) || price < 0) return [];

    return [{
      name: product.name.slice(0, 120),
      category: product.category.slice(0, 60),
      type: typeof product.type === 'string' ? product.type.slice(0, 100) : '',
      price
    }];
  });
}

async function handleChat(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    sendJson(response, 405, { error: 'Method not allowed.' });
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    sendJson(response, 503, { error: 'Server chưa cấu hình GEMINI_API_KEY.' });
    return;
  }

  if (isRateLimited(request.socket.remoteAddress || 'unknown')) {
    response.setHeader('Retry-After', '60');
    sendJson(response, 429, { error: 'Bạn gửi tin nhắn hơi nhanh. Vui lòng thử lại sau một phút.' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const messages = cleanMessages(body.messages);
    if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
      sendJson(response, 400, { error: 'Tin nhắn chưa hợp lệ.' });
      return;
    }

    const products = cleanProducts(body.products);
    const catalog = products.length
      ? products.map(product => `- ${product.name} | ${product.category} | ${product.type} | ${new Intl.NumberFormat('vi-VN').format(product.price)}đ`).join('\n')
      : 'Chưa có dữ liệu sản phẩm.';
    const systemInstruction = [
      'Bạn là Tangbot, trợ lý mua sắm của cửa hàng thể thao Tangfootball. Luôn trả lời bằng tiếng Việt, thân thiện, ngắn gọn và hữu ích.',
      'Dùng đúng danh mục sản phẩm và giá ở catalog bên dưới; không tự bịa sản phẩm, tồn kho, giá, khuyến mãi hoặc thông tin đơn hàng.',
      'Chính sách cửa hàng: giao hàng toàn quốc 1-3 ngày; miễn phí vận chuyển cho đơn từ 1.000.000đ; hỗ trợ đổi trả trong 7 ngày. Hotline hỗ trợ: 0901 234 567.',
      'Không khẳng định đã tạo đơn, thanh toán, kiểm tra tồn kho hoặc đổi trả thành công. Với yêu cầu đó, hướng dẫn khách liên hệ cửa hàng.',
      'Catalog sản phẩm hiện tại:\n' + catalog
    ].join('\n\n');
    const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: messages.map(message => ({ role: message.role, parts: [{ text: message.text }] })),
          generationConfig: { temperature: 0.6, maxOutputTokens: 512 }
        }),
        signal: AbortSignal.timeout(30_000)
      }
    );

    if (!geminiResponse.ok) {
      console.error(`Gemini API returned HTTP ${geminiResponse.status}.`);
      sendJson(response, 502, { error: 'Gemini chưa thể trả lời lúc này. Bạn thử lại sau nhé.' });
      return;
    }

    const result = await geminiResponse.json();
    const reply = result.candidates?.[0]?.content?.parts
      ?.map(part => part.text || '')
      .join('')
      .trim();
    if (!reply) {
      sendJson(response, 502, { error: 'Gemini chưa tạo được câu trả lời. Bạn thử hỏi lại nhé.' });
      return;
    }

    sendJson(response, 200, { reply });
  } catch (error) {
    if (response.headersSent) return;
    if (error.statusCode) {
      sendJson(response, error.statusCode, { error: error.message });
      return;
    }
    console.error('Chat request failed:', error.message);
    sendJson(response, 502, { error: 'Không kết nối được Gemini. Bạn thử lại sau nhé.' });
  }
}

function serveStatic(request, response, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method not allowed.');
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname).replaceAll('\\', '/');
  } catch {
    response.writeHead(400);
    response.end('Bad request.');
    return;
  }

  const relativePath = decodedPath.replace(/^\/+/, '') || 'index.html';
  const filePath = path.resolve(projectRoot, relativePath);
  if (!filePath.startsWith(projectRoot + path.sep) || relativePath.split('/').some(part => part.startsWith('.')) || ['server.js', 'package.json'].includes(path.basename(filePath))) {
    response.writeHead(404);
    response.end('Not found.');
    return;
  }

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      response.end(error.code === 'ENOENT' ? 'Not found.' : 'Could not read file.');
      return;
    }

    const contentTypes = {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.ico': 'image/x-icon',
      '.jpeg': 'image/jpeg',
      '.jpg': 'image/jpeg',
      '.js': 'text/javascript; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp'
    };
    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(request.method === 'HEAD' ? undefined : contents);
  });
}

loadEnvFile();
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';
const server = http.createServer((request, response) => {
  let pathname;
  try {
    pathname = new URL(request.url, 'http://localhost').pathname;
  } catch {
    response.writeHead(400);
    response.end('Bad request.');
    return;
  }

  if (pathname === '/api/chat') {
    handleChat(request, response);
    return;
  }
  serveStatic(request, response, pathname);
});

server.listen(port, host, () => {
  console.log(`Tangfootball is running at http://localhost:${port}`);
});
