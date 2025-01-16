// Importacions necessàries
const Conversation = require('../models/Conversation');
const Prompt = require('../models/Prompt');
const { validateUUID } = require('../middleware/validators');
const axios = require('axios');
const { logger } = require('../config/logger');

// Constants de configuració
const OLLAMA_API_URL = process.env.CHAT_API_OLLAMA_URL || 'http://localhost:11434/api';
const DEFAULT_OLLAMA_MODEL = process.env.CHAT_API_OLLAMA_MODEL || 'llama3:latest';

/**
 * Retorna la llista de models disponibles a Ollama
 * @route GET /api/chat/models
 */
const listOllamaModels = async (req, res, next) => {
    try {
        logger.info('Sol·licitant llista de models a Ollama');
        const response = await axios.get(`${OLLAMA_API_URL}/tags`);
        
        const models = response.data.models.map(model => ({
            name: model.name,
            modified_at: model.modified_at,
            size: model.size,
            digest: model.digest
        }));

        logger.info(`Models recuperats correctament`, { count: models.length });
        res.json({
            total_models: models.length,
            models: models
        });
    } catch (error) {
        logger.error('Error recuperant models d\'Ollama', {
            error: error.message,
            url: `${OLLAMA_API_URL}/tags`
        });
        
        if (error.response) {
            res.status(error.response.status).json({
                message: 'No s\'han pogut recuperar els models',
                error: error.response.data
            });
        } else {
            next(error);
        }
    }
};

/**
 * Genera una resposta utilitzant el model d'Ollama
 * @param {string} prompt - Text d'entrada per generar la resposta
 * @param {Object} options - Opcions de configuració
 * @returns {Promise<string>} Resposta generada
 */
const generateResponse = async (prompt, options = {}) => {
    try {
        const {
            model = DEFAULT_OLLAMA_MODEL,
            stream = false
        } = options;

        logger.debug('Iniciant generació de resposta', { 
            model, 
            stream,
            promptLength: prompt.length 
        });

        const requestBody = {
            model,
            prompt,
            stream
        };

        const response = await axios.post(`${OLLAMA_API_URL}/generate`, requestBody, {
            timeout: 30000,
            responseType: stream ? 'stream' : 'json'
        });

        // Gestió diferent per respostes en streaming i no streaming
        if (stream) {
            return new Promise((resolve, reject) => {
                let fullResponse = '';
                
                response.data.on('data', (chunk) => {
                    const chunkStr = chunk.toString();
                    try {
                        const parsedChunk = JSON.parse(chunkStr);
                        if (parsedChunk.response) {
                            fullResponse += parsedChunk.response;
                        }
                    } catch (parseError) {
                        logger.error('Error processant chunk de resposta', { 
                            error: parseError.message,
                            chunk: chunkStr 
                        });
                    }
                });
                
                response.data.on('end', () => {
                    logger.debug('Generació en streaming completada', {
                        responseLength: fullResponse.length
                    });
                    resolve(fullResponse.trim());
                });
                
                response.data.on('error', (error) => {
                    logger.error('Error en streaming', { error: error.message });
                    reject(error);
                });
            });
        }

        logger.debug('Resposta generada correctament', {
            responseLength: response.data.response.length
        });
        return response.data.response.trim();
    } catch (error) {
        logger.error('Error en la generació de resposta', {
            error: error.message,
            model: options.model,
            stream: options.stream
        });
        
        if (error.response?.data) {
            logger.error('Detalls de l\'error d\'Ollama', { 
                details: error.response.data 
            });
        }

        return 'Ho sento, no he pogut generar una resposta en aquest moment.';
    }
};

/**
 * Registra un nou prompt i genera una resposta
 * @route POST /api/chat/prompt
 */
const registerPrompt = async (req, res, next) => {
    try {
        const { 
            conversationId, 
            prompt, 
            model = DEFAULT_OLLAMA_MODEL, 
            stream = false 
        } = req.body;

        logger.info('Nova sol·licitud de prompt rebuda', {
            hasConversationId: !!conversationId,
            model,
            stream,
            promptLength: prompt?.length
        });

        // Validacions inicials
        if (!prompt?.trim()) {
            logger.warn('Intent de registrar prompt buit');
            return res.status(400).json({ message: 'El prompt és obligatori' });
        }

        // Gestió de la conversa
        let conversation;
        if (conversationId) {
            if (!validateUUID(conversationId)) {
                logger.warn('ID de conversa invàlid', { conversationId });
                return res.status(400).json({ message: 'ID de conversa invàlid' });
            }
            
            conversation = await Conversation.findByPk(conversationId);
            
            if (!conversation) {
                logger.info('Creant nova conversa amb ID proporcionat', { conversationId });
                conversation = await Conversation.create({ id: conversationId });
            }
        } else {
            logger.info('Creant nova conversa sense ID específic');
            conversation = await Conversation.create();
        }

        // Gestió de streaming vs no-streaming
        if (stream) {
            await handleStreamingResponse(req, res, conversation, prompt, model);
        } else {
            await handleNormalResponse(req, res, conversation, prompt, model);
        }
    } catch (error) {
        logger.error('Error en el procés de registre de prompt', {
            error: error.message,
            stack: error.stack
        });
        next(error);
    }
};

/**
 * Gestiona la resposta en mode streaming
 * @private
 */
async function handleStreamingResponse(req, res, conversation, prompt, model) {
    // Configuració de SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const newPrompt = await Prompt.create({
        prompt: prompt.trim(),
        response: '',
        model,
        stream: true,
        ConversationId: conversation.id
    });

    logger.debug('Iniciant resposta en streaming', {
        promptId: newPrompt.id,
        conversationId: conversation.id
    });

    // Event inicial
    res.write(`data: ${JSON.stringify({
        type: 'start',
        conversationId: conversation.id,
        promptId: newPrompt.id,
        prompt: prompt.trim()
    })}\n\n`);

    try {
        await processStreamingResponse(res, conversation, newPrompt, prompt, model);
    } catch (error) {
        logger.error('Error en streaming', {
            error: error.message,
            promptId: newPrompt.id
        });
        res.write(`data: ${JSON.stringify({
            type: 'error',
            error: 'Error en el procés de streaming'
        })}\n\n`);
        res.end();
    }
}

/**
 * Gestiona la resposta normal (no streaming)
 * @private
 */
async function handleNormalResponse(req, res, conversation, prompt, model) {
    try {
        logger.debug('Generant resposta no streaming', {
            conversationId: conversation.id,
            model
        });

        const ollamaResponse = await generateResponse(prompt, { model });
        
        const newPrompt = await Prompt.create({
            prompt: prompt.trim(),
            response: ollamaResponse,
            model,
            stream: false,
            ConversationId: conversation.id
        });

        logger.info('Prompt registrat correctament', {
            promptId: newPrompt.id,
            conversationId: conversation.id
        });

        res.status(201).json({
            conversationId: conversation.id,
            promptId: newPrompt.id,
            prompt: newPrompt.prompt,
            response: newPrompt.response,
            message: 'Prompt registrat correctament'
        });
    } catch (error) {
        logger.error('Error en generar resposta normal', {
            error: error.message,
            conversationId: conversation.id
        });
        next(error);
    }
}

/**
 * Processa la resposta en streaming d'Ollama
 * @private
 */
async function processStreamingResponse(res, conversation, prompt, promptText, model) {
    const ollamaResponse = await axios.post(`${OLLAMA_API_URL}/generate`, {
        model,
        prompt: promptText,
        stream: true
    }, {
        responseType: 'stream'
    });

    let fullResponse = '';

    ollamaResponse.data.on('data', async (chunk) => {
        try {
            const parsedChunk = JSON.parse(chunk.toString());
            
            if (parsedChunk.response) {
                fullResponse += parsedChunk.response;
                
                res.write(`data: ${JSON.stringify({
                    type: 'chunk',
                    conversationId: conversation.id,
                    promptId: prompt.id,
                    chunk: parsedChunk.response
                })}\n\n`);
            }
            
            if (parsedChunk.done) {
                await prompt.update({ response: fullResponse });
                
                res.write(`data: ${JSON.stringify({
                    type: 'end',
                    conversationId: conversation.id,
                    promptId: prompt.id,
                    fullResponse: fullResponse
                })}\n\n`);
                
                res.end();
            }
        } catch (error) {
            throw new Error('Error processant la resposta en streaming');
        }
    });

    ollamaResponse.data.on('error', (error) => {
        throw error;
    });
}

/**
 * Recupera una conversa amb tots els seus prompts
 * @route GET /api/chat/conversation/:id
 */
const getConversation = async (req, res, next) => {
    try {
        const { id } = req.params;

        logger.debug('Sol·licitud de recuperació de conversa', { conversationId: id });

        if (!validateUUID(id)) {
            logger.warn('Intent de recuperar conversa amb ID invàlid', { id });
            return res.status(400).json({ message: 'ID de conversa invàlid' });
        }

        const conversation = await Conversation.findByPk(id);
        if (!conversation) {
            logger.warn('Conversa no trobada', { id });
            return res.status(404).json({ message: 'Conversa no trobada' });
        }

        const conversationWithPrompts = await Conversation.findByPk(id, {
            include: {
                model: Prompt,
                attributes: ['id', 'prompt', 'response', 'createdAt']
            },
            order: [[Prompt, 'createdAt', 'ASC']]
        });

        logger.info('Conversa recuperada correctament', {
            conversationId: id,
            promptCount: conversationWithPrompts.Prompts.length
        });

        res.json(conversationWithPrompts);
    } catch (error) {
        logger.error('Error en recuperar conversa', {
            error: error.message,
            conversationId: req.params.id
        });
        next(error);
    }
};

/**
 * Envia una frase, y analitza quin sentiment evoca
 * @route POST /api/chat/sentiment-analysis
 */
const sentimentPrompt = async (req, res, next) => {
    try {
        const { 
            conversationId, 
            prompt, 
            model = DEFAULT_OLLAMA_MODEL, 
            stream = false 
        } = req.body;

        logger.info('Nova sol·licitud de prompt rebuda', {
            hasConversationId: !!conversationId,
            model,
            stream,
            promptLength: prompt?.length
        });

        // Validacions inicials
        if (!prompt?.trim()) {
            logger.warn('Intent de registrar prompt buit');
            return res.status(400).json({ message: 'El prompt és obligatori' });
        }

        // Gestió de la conversa
        let conversation;
        if (conversationId) {
            if (!validateUUID(conversationId)) {
                logger.warn('ID de conversa invàlid', { conversationId });
                return res.status(400).json({ message: 'ID de conversa invàlid' });
            }
            
            conversation = await Conversation.findByPk(conversationId);
            
            if (!conversation) {
                logger.info('Creant nova conversa amb ID proporcionat', { conversationId });
                conversation = await Conversation.create({ id: conversationId });
            }
        } else {
            logger.info('Creant nova conversa sense ID específic');
            conversation = await Conversation.create();
        }

        // Gestió del streaming vs no-streaming
        if (stream) {
            await handleStreamingResponse(req, res, conversation, prompt, model);
        } else {
            const sentimentAnalysisResponse = await handleSentimentAnalysis(prompt, model);
            
            // Retornar la resposta
            res.json({
                sentiment: sentimentAnalysisResponse.sentiment,
                confidence: sentimentAnalysisResponse.confidence,
                conversationId: conversation.id,
            });
        }
    } catch (error) {
        logger.error('Error en el procés de registre de prompt', {
            error: error.message,
            stack: error.stack
        });
        next(error);
    }
};

/**
 * Funció que fa el procés d'anàlisi de sentiment
 * @param {string} prompt - La frase per analitzar el sentiment
 * @param {string} model - El model d'Ollama per utilitzar
 * @returns {Object} - Retorna el sentiment  en l'anàlisi
 */
async function handleSentimentAnalysis(prompt, model) {
    const sentimentPrompt = `Donada la seguent oracio: -${prompt}-, analitza el sentiment y retorna una de las seguents opcions: -Positiu-, -Negatiu- o -Neutral-. A més, inclou un valor de confiança entre 0 y 1 a la resposta respuesta. Devuelve esto en el siguiente formato Sentiment: ejemplo`;
    
    const response = await generateResponse(sentimentPrompt, { model });

    if (response) {
        const { sentiment } = parseSentimentResponse(response);
        return { sentiment };
    } else {
        throw new Error('No s\'ha pogut obtenir una resposta vàlida del model');
    }
}

/**
 * Funció per parsejar la resposta del model d'Ollama
 * @param {string} response - Resposta del model d'Ollama
 * @returns {Object} - Objecte amb sentiment 
 */
function parseSentimentResponse(response) {
   
    const sentimentMatch = response.match(/Sentiment: (\w+)/);

    return {
        sentiment: sentimentMatch ? sentimentMatch[1] : 'Desconegut'
    };
}

// Exportació de les funcions públiques
module.exports = {
    registerPrompt,
    getConversation,
    listOllamaModels,
    sentimentPrompt
};