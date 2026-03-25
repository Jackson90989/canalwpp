// whatsapp-api.js
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const chromium = require('chromium');
const app = express();
app.use(express.json());

const API_KEY = process.env.WHATSAPP_API_KEY || '';
const RESPONSE_PROVIDER = (process.env.WHATSAPP_RESPONSE_PROVIDER || 'gemini').toLowerCase();
const FLASK_WEBHOOK_URL = process.env.FLASK_WEBHOOK_URL || 'http://localhost:5000/api/whatsapp-webhook';
const FLASK_TIMEOUT_MS = Number(process.env.FLASK_TIMEOUT_MS || 90000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyA2b9-5QWu8a9ZiQ0aQOkGIlx9LzQHA46A';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 60000);
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const SESSIONS_DIR = path.resolve(process.env.WHATSAPP_SESSIONS_DIR || './sessions');
const LOCK_FILE = path.join(SESSIONS_DIR, '.whatsapp-api.lock');

let lockFd = null;

function processExists(pid) {
    if (!pid || Number.isNaN(Number(pid))) {
        return false;
    }

    try {
        process.kill(Number(pid), 0);
        return true;
    } catch {
        return false;
    }
}

function acquireSingleInstanceLock() {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });

    try {
        lockFd = fs.openSync(LOCK_FILE, 'wx');
        const lockPayload = {
            pid: process.pid,
            createdAt: new Date().toISOString(),
            cwd: process.cwd()
        };
        fs.writeFileSync(lockFd, JSON.stringify(lockPayload, null, 2));
        return;
    } catch (error) {
        if (error && error.code !== 'EEXIST') {
            throw error;
        }
    }

    // Lock existente: tentar validar se processo ainda está vivo.
    let lockInfo = null;
    try {
        lockInfo = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    } catch {
        // lock corrompido ou ilegivel
    }

    const pidAtivo = lockInfo && processExists(lockInfo.pid);
    if (pidAtivo) {
        throw new Error(
            `Ja existe uma instancia do whatsapp-api em execucao (PID ${lockInfo.pid}). ` +
            'Encerre a instancia atual antes de iniciar outra.'
        );
    }

    // Lock órfão: remove e tenta novamente.
    try {
        fs.unlinkSync(LOCK_FILE);
    } catch {
        // ignora, tentativa final abaixo dira se foi possivel adquirir
    }

    lockFd = fs.openSync(LOCK_FILE, 'wx');
    const lockPayload = {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        cwd: process.cwd(),
        recoveredStaleLock: true
    };
    fs.writeFileSync(lockFd, JSON.stringify(lockPayload, null, 2));
}

function releaseSingleInstanceLock() {
    try {
        if (lockFd !== null) {
            fs.closeSync(lockFd);
            lockFd = null;
        }
        if (fs.existsSync(LOCK_FILE)) {
            const lockInfo = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
            if (Number(lockInfo.pid) === Number(process.pid)) {
                fs.unlinkSync(LOCK_FILE);
            }
        }
    } catch {
        // sem throw em encerramento
    }
}

try {
    acquireSingleInstanceLock();
} catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNetworkError(error) {
    const retryableCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);
    return retryableCodes.has(error?.code);
}

async function enviarParaFlaskComRetry(payload, maxTentativas = 3) {
    let ultimaErro = null;

    for (let tentativa = 1; tentativa <= maxTentativas; tentativa += 1) {
        try {
            const response = await axios.post(FLASK_WEBHOOK_URL, payload, {
                timeout: FLASK_TIMEOUT_MS,
                headers: { 'Content-Type': 'application/json' }
            });
            return response;
        } catch (error) {
            ultimaErro = error;
            const retryavel = isRetryableNetworkError(error);
            const ultimaTentativa = tentativa === maxTentativas;

            console.error(`Failed to call Flask (attempt ${tentativa}/${maxTentativas})`, {
                code: error?.code || null,
                message: error?.message || 'unknown error'
            });

            if (!retryavel || ultimaTentativa) {
                throw error;
            }

            // Backoff curto para evitar tempestade de tentativas
            await sleep(300 * tentativa);
        }
    }

    throw ultimaErro;
}

function usarGeminiDireto() {
    return RESPONSE_PROVIDER === 'gemini';
}

function geminiConfigurado() {
    return Boolean(GEMINI_API_KEY);
}

async function gerarRespostaGemini(mensagem, numero) {
    const prompt = [
        'Voce e um assistente educacional da UNIN (uma faculdade muito boa).',
        'Responda em portugues do Brasil, de forma objetiva e acolhedora.',
        `Numero do aluno: ${numero}`,
        `Mensagem do aluno: ${mensagem}`
    ].join('\n');

    const response = await axios.post(
        GEMINI_API_URL,
        {
            contents: [
                {
                    parts: [
                        { text: prompt }
                    ]
                }
            ]
        },
        {
            timeout: GEMINI_TIMEOUT_MS,
            headers: {
                'Content-Type': 'application/json',
                'X-goog-api-key': GEMINI_API_KEY
            }
        }
    );

    const parts = response?.data?.candidates?.[0]?.content?.parts || [];
    const texto = parts
        .map((item) => (typeof item?.text === 'string' ? item.text : ''))
        .join('')
        .trim();

    if (!texto) {
        throw new Error('Gemini returned empty content');
    }

    return texto;
}

function requireApiKey(req, res, next) {
    // Mantem compatibilidade: se nao houver chave configurada, nao bloqueia.
    if (!API_KEY) {
        return next();
    }

    const receivedKey = req.headers['x-api-key'];
    if (receivedKey !== API_KEY) {
        return res.status(401).json({
            sucesso: false,
            erro: 'Nao autorizado'
        });
    }

    return next();
}

function safeMessagePreview(text, maxLen = 80) {
    if (!text) {
        return '';
    }
    const normalized = String(text).replace(/\s+/g, ' ').trim();
    return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}...` : normalized;
}

function extrairCaminhoPdfDaResposta(texto) {
    if (!texto) {
        return null;
    }

    const normalizado = String(texto).replace(/`/g, '');
    const match = normalizado.match(/(documentos_gerados[\\/][^\s*]+)/i);
    return match ? match[1] : null;
}

function limparLinhaCaminhoPdf(texto) {
    if (!texto) {
        return '';
    }

    const textoNormalizado = String(texto).replace(/`/g, '');

    // Troca a linha que expoe caminho local por mensagem amigavel.
    return textoNormalizado.replace(
        /^\s*📎\s*\*\*?PDF\s+gerado:\*\*?\s*documentos_gerados[\\/].*$/gim,
        '📎 **PDF enviado em anexo.** Se nao abrir, me avise que eu reenvio.'
    );
}

function isValidChatNumber(numero) {
    const digits = String(numero || '').replace(/\D/g, '');
    // Aceita E.164 BR sem +: 55 + DDD + numero (12 ou 13 digitos)
    return digits.length >= 12 && digits.length <= 13;
}

let clientReady = false;
let qrGenerated = false;

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSIONS_DIR }),
    puppeteer: {
        executablePath: chromium.path,
        headless: true,
        args: [
            ...chromium.args,
            '--no-sandbox',
            '--disable-setuid-sandbox',
        ],
    }
});

// Função para verificar se é mensagem individual
function isIndividualMessage(message) {
    // WhatsApp Web usa @c.us para contatos individuais
    // @g.us é para grupos
    // @broadcast é para transmissões
    
    const isIndividual = message.from.includes('@c.us');
    const isGroup = message.from.includes('@g.us');
    const isBroadcast = message.from.includes('@broadcast');
    const isStatus = message.from === 'status@broadcast';
    
    console.log(`Debug - Message type:`);
    console.log(`   • From: ${message.from}`);
    console.log(`   • Individual (@c.us): ${isIndividual}`);
    console.log(`   • Group (@g.us): ${isGroup}`);
    console.log(`   • Broadcast: ${isBroadcast}`);
    console.log(`   • Status: ${isStatus}`);
    
    // Retorna true APENAS se for mensagem individual
    return isIndividual && !isGroup && !isBroadcast && !isStatus;
}

// Evento para gerar QR Code
client.on('qr', (qr) => {
    qrGenerated = true;
    console.log('\nScan the QR code below with WhatsApp:');
    qrcode.generate(qr, {small: true});
    console.log('\nOpen WhatsApp on your phone > Menu > WhatsApp Web');
});

// Evento quando cliente está pronto
client.on('ready', () => {
    clientReady = true;
    qrGenerated = false;
    console.log('WhatsApp client connected successfully!');
    console.log(`Number: ${client.info?.wid?.user || 'Unknown'}`);
});

client.on('authenticated', () => {
    console.log('Authenticated successfully!');
});

client.on('auth_failure', (msg) => {
    console.error('Authentication failed:', msg);
    clientReady = false;
});

client.on('disconnected', (reason) => {
    console.log('Client disconnected:', reason);
    clientReady = false;
});

// Quando uma mensagem chegar no WhatsApp
client.on('message', async (message) => {
    console.log(`\nMessage received from ${message.from}: ${safeMessagePreview(message.body)}`);

    if (!message.body || !String(message.body).trim()) {
        console.log('Skipping empty message');
        return;
    }
    
    // IGNORAR MENSAGENS DE GRUPO COMPLETAMENTE
    if (!isIndividualMessage(message)) {
        console.log(`Skipping message (not individual): ${message.from}`);
        return; // Não faz nada com mensagens de grupo
    }
    
    // Ignorar mensagens do próprio bot
    if (message.fromMe) {
        console.log(`Skipping bot's own message`);
        return;
    }
    
    console.log(`Processing individual message from: ${message.from}`);
    
    try {
        let respostaOriginal = '';

        if (usarGeminiDireto()) {
            if (!geminiConfigurado()) {
                throw new Error('Gemini mode enabled but GEMINI_API_KEY is not configured');
            }
            respostaOriginal = await gerarRespostaGemini(message.body, message.from);
        } else {
            // Enviar a mensagem para seu sistema Flask
            const response = await enviarParaFlaskComRetry({
                numero: message.from,
                mensagem: message.body,
                tipo: 'recebida',
                pipeline: 'aluno_avancado',
                message_id: message.id._serialized,
                timestamp: new Date().toISOString()
            });
            respostaOriginal = String(response?.data?.resposta || '');
        }

        // Enviar a resposta de volta ao WhatsApp
        if (respostaOriginal) {
            const caminhoRelativoPdf = extrairCaminhoPdfDaResposta(respostaOriginal);
            const respostaTexto = caminhoRelativoPdf
                ? limparLinhaCaminhoPdf(respostaOriginal)
                : respostaOriginal;

            await message.reply(respostaTexto);
            console.log('Reply sent successfully');

            // Se houver caminho de PDF na resposta, enviar o documento anexado.
            if (caminhoRelativoPdf) {
                try {
                    const caminhoAbsolutoPdf = path.resolve(caminhoRelativoPdf);
                    if (fs.existsSync(caminhoAbsolutoPdf)) {
                        const media = MessageMedia.fromFilePath(caminhoAbsolutoPdf);
                        await message.reply(media, undefined, {
                            sendMediaAsDocument: true,
                            caption: 'Segue o PDF em anexo. Se nao abrir, me avise que eu reenvio.'
                        });
                        console.log(`Attached PDF sent in chat: ${caminhoAbsolutoPdf}`);
                    } else {
                        console.warn(`PDF referenced in reply not found: ${caminhoAbsolutoPdf}`);
                    }
                } catch (pdfError) {
                    console.error('Failed to send attached PDF in chat:', pdfError?.message || pdfError);
                }
            }
        }
    } catch (error) {
        console.error('Error generating reply:', {
            code: error?.code || null,
            message: error?.message || 'unknown error'
        });
        
        // Mensagem de fallback em caso de erro
        try {
            await message.reply('Sorry, I am having trouble processing your message. Please try again in a moment.');
        } catch (replyError) {
            console.error('Error sending fallback message:', replyError.message);
        }
    }
});

// Endpoint para enviar mensagens (seu Flask chama aqui)
app.post('/enviar', requireApiKey, async (req, res) => {
    const { numero, mensagem } = req.body;
    
    if (!numero || !mensagem) {
        return res.status(400).json({ 
            sucesso: false, 
            erro: 'Número e mensagem são obrigatórios' 
        });
    }
    
    if (!clientReady) {
        return res.status(503).json({ 
            sucesso: false, 
            erro: 'Cliente WhatsApp não está pronto' 
        });
    }

    if (!isValidChatNumber(numero)) {
        return res.status(400).json({
            sucesso: false,
            erro: 'Numero invalido. Use formato com codigo do pais e DDD (ex: 5511999999999)'
        });
    }
    
    try {
        // Garantir formato correto do número (sempre individual)
        const numeroLimpo = numero.replace(/\D/g, '');
        const chatId = `${numeroLimpo}@c.us`; // Força @c.us para individual
        
        const response = await client.sendMessage(chatId, mensagem);
        console.log(`Message sent to ${numero}`);
        
        res.json({ 
            sucesso: true, 
            id: response.id._serialized,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error sending message:', error.message);
        res.status(500).json({ 
            sucesso: false, 
            erro: error.message 
        });
    }
});

// Endpoint para enviar arquivos (PDF, imagem, etc.)
app.post('/enviar-arquivo', requireApiKey, async (req, res) => {
    const { numero, arquivo, legenda } = req.body;

    if (!numero || !arquivo) {
        return res.status(400).json({
            sucesso: false,
            erro: 'Numero e arquivo sao obrigatorios'
        });
    }

    if (!clientReady) {
        return res.status(503).json({
            sucesso: false,
            erro: 'Cliente WhatsApp nao esta pronto'
        });
    }

    if (!isValidChatNumber(numero)) {
        return res.status(400).json({
            sucesso: false,
            erro: 'Numero invalido. Use formato com codigo do pais e DDD (ex: 5511999999999)'
        });
    }

    try {
        const numeroLimpo = String(numero).replace(/\D/g, '');
        const numeroId = await client.getNumberId(numeroLimpo);
        const chatId = numeroId?._serialized || `${numeroLimpo}@c.us`;
        const arquivoAbsoluto = path.resolve(String(arquivo));

        if (!fs.existsSync(arquivoAbsoluto)) {
            return res.status(404).json({
                sucesso: false,
                erro: `Arquivo nao encontrado: ${arquivoAbsoluto}`
            });
        }

        const media = MessageMedia.fromFilePath(arquivoAbsoluto);
        const response = await client.sendMessage(chatId, media, {
            caption: legenda || '',
            sendMediaAsDocument: true
        });

        console.log(`File sent to ${numeroLimpo}: ${arquivoAbsoluto}`);
        return res.json({
            sucesso: true,
            id: response.id._serialized,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error sending file:', error.message);
        return res.status(500).json({
            sucesso: false,
            erro: error.message
        });
    }
});

// Endpoint para verificar status
app.get('/status', (req, res) => {
    res.json({
        status: clientReady ? 'online' : 'offline',
        qr_generated: qrGenerated,
        response_provider: RESPONSE_PROVIDER,
        gemini_configured: geminiConfigurado(),
        info: client.info ? {
            number: client.info.wid.user,
            pushname: client.info.pushname,
            platform: client.info.platform
        } : null
    });
});

// Endpoint para reiniciar cliente
app.post('/restart', requireApiKey, async (req, res) => {
    try {
        clientReady = false;
        qrGenerated = false;
        await client.destroy();
        client.initialize();
        res.json({ sucesso: true, mensagem: 'Cliente reiniciado' });
    } catch (error) {
        res.status(500).json({ sucesso: false, erro: error.message });
    }
});

// Inicializar cliente
client.initialize();

// Iniciar servidor
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`\nWhatsApp API running on port ${PORT}`);
    console.log(`Endpoints:`);
    console.log(`   POST http://localhost:${PORT}/enviar - Send message`);
    console.log(`   POST http://localhost:${PORT}/enviar-arquivo - Send file`);
    console.log(`   GET  http://localhost:${PORT}/status - Check status`);
    console.log(`   POST http://localhost:${PORT}/restart - Restart client`);
    console.log(`\nFlask webhook: ${FLASK_WEBHOOK_URL}`);
    console.log(`Flask timeout: ${FLASK_TIMEOUT_MS}ms`);
    console.log(`Gemini model: ${GEMINI_MODEL}`);
    console.log(`Gemini timeout: ${GEMINI_TIMEOUT_MS}ms`);
    console.log(`\nAPI key security: ${API_KEY ? 'ENABLED' : 'DISABLED (set WHATSAPP_API_KEY)'}`);
    console.log(`Response provider: ${RESPONSE_PROVIDER}`);
    if (usarGeminiDireto() && !geminiConfigurado()) {
        console.log('Warning: Gemini mode enabled but GEMINI_API_KEY is missing');
    }
    console.log(`\nConfiguration: INDIVIDUAL messages only (@c.us)`);
    console.log(`   Group messages will be ignored`);
});

// Tratamento de encerramento
process.on('SIGINT', async () => {
    console.log('\nShutting down WhatsApp client...');
    await client.destroy();
    releaseSingleInstanceLock();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\nShutting down WhatsApp client (SIGTERM)...');
    try {
        await client.destroy();
    } catch {
        // ignorar
    }
    releaseSingleInstanceLock();
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('Fatal error:', error?.message || error);
    releaseSingleInstanceLock();
    process.exit(1);
});