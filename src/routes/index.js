const express = require('express');
const catalogRoutes = require('./catalog');
const configureRoutes = require('./configure');
const manifestRoutes = require('./manifest');
const metaRoutes = require('./meta');
const posterRoutes = require('./poster');
const providersRoutes = require('./providers');
const streamRoutes = require('./stream');
const traktRoutes = require('./trakt');
const log = require('../helpers/logger');

const router = express.Router();

const isBase64 = (str) => {
    try {
        return Buffer.from(str, 'base64').toString('base64') === str;
    } catch (err) {
        return false;
    }
};

const decodeBase64Middleware = (req, res, next) => {
    // Skip base64 decoding for specific routes
    if (req.path.startsWith('/callback') || 
        req.path.startsWith('/updateWatched') ||
        req.path.startsWith('/configure') || 
        req.path.startsWith('/assets/') ||
        req.path.startsWith('/poster/')) {
        return next();
    }

    try {
        const pathParts = req.path.split('/');

        const decodedParts = pathParts.map(part => {
            if (isBase64(part)) {
                try {
                    const decoded = Buffer.from(part, 'base64').toString('utf8');
                    return decoded;
                } catch (e) {
                    log.error(`Error decoding part: ${e.message}`);
                    return part;
                }
            } else {
                return part;
            }
        });

        req.url = decodedParts.join('/');
        next();
    } catch (error) {
        log.error('Base64 decoding error:', error);
        res.status(400).send('Bad request: Invalid base64 encoding.');
    }
};

// Apply base64 decoding middleware
router.use(decodeBase64Middleware);

// Logging middleware
router.use((req, res, next) => {
    log.info(`--- Request received ---`);
    log.info(`${req.method} ${req.originalUrl}`);
    next();
});

// Register all routes
router.use(catalogRoutes);
router.use(configureRoutes);
router.use(manifestRoutes);
router.use(metaRoutes);
router.use(posterRoutes);
router.use(providersRoutes);
router.use(streamRoutes);
router.use(traktRoutes);

// Error handling middleware
router.use((err, req, res, next) => {
    const errorTime = new Date().toISOString();
    log.error(`${errorTime} - Error: ${err.stack}`);

    if (!res.headersSent) {
        res.status(500).send(`Something broke! If you need help, please provide this timestamp to the developer: ${errorTime}`);
    }
});

// 404 handler
router.use((req, res) => {
    log.warn(`404 Not Found: ${req.originalUrl}`);
    res.status(404).send('Not Found');
});

module.exports = router;
