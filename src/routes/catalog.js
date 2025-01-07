const express = require('express');
const log = require('../helpers/logger');
const { parseConfigParameters, extractCatalogInfo, getGenreId, fetchDiscoverContent, buildMetas } = require('../helpers/catalog');
const { handleTraktHistory } = require('../api/trakt');

const router = express.Router();

router.get("/:configParameters?/catalog/:type/:id/:extra?.json", async (req, res, next) => {
    try {
        const { id, configParameters, type, extra: extraParam } = req.params;
        const extra = extraParam ? decodeURIComponent(extraParam) : '';
        let skip = 0;

        const origin = req.get('origin');
        const userAgent = req.headers['user-agent'] || '';
        log.debug(`Request Origin: ${origin}, User-Agent: ${userAgent}`);

        log.debug(`Received parameters: id=${id}, type=${type}, configParameters=${configParameters}, extra=${extra}`);

        // Parse configuration parameters
        const parsedConfig = await parseConfigParameters(configParameters);
        
        // Extract catalog info from ID
        const { catalogType, providerId } = extractCatalogInfo(id);
        const providers = [providerId.toString()];

        // Handle skip parameter for pagination
        if (extra.startsWith('skip=')) {
            const skipValue = parseInt(extra.split('=')[1], 10);
            skip = isNaN(skipValue) ? 0 : skipValue;
        }

        // Extract filter parameters
        const yearMatch = extra.match(/year=([^&]+)/);
        const ratingMatch = extra.match(/rating=([^&]+)/);
        const genreMatch = extra.match(/genre=([^&]+)/);

        let year = yearMatch ? yearMatch[1] : null;
        let rating = ratingMatch ? ratingMatch[1] : null;
        let genre = genreMatch ? genreMatch[1] : null;

        // Convert genre name to ID if present
        if (genre) {
            genre = await getGenreId(genre, type);
        }

        // Determine sort order based on catalog type
        const sortBy = catalogType === 'movies'
            ? (id.includes('-new') ? 'primary_release_date.desc' : 'popularity.desc')
            : (id.includes('-new') ? 'first_air_date.desc' : 'popularity.desc');

        // Fetch content from TMDB
        const discoverResults = await fetchDiscoverContent(
            catalogType,
            providers,
            parsedConfig.ageRange,
            sortBy,
            genre,
            parsedConfig.tmdbApiKey,
            parsedConfig.language,
            skip,
            parsedConfig.regions,
            year,
            rating
        );

        // Filter results
        let filteredResults = discoverResults.results;

        // Filter out content without posters if configured
        if (parsedConfig.filterContentWithoutPoster === 'true') {
            filteredResults = filteredResults.filter(content => content.poster_path);
        }

        // Handle Trakt history if enabled
        if (parsedConfig.hideTraktHistory === 'true' && parsedConfig.traktUsername) {
            filteredResults = await handleTraktHistory(
                parsedConfig, 
                filteredResults, 
                catalogType,
                parsedConfig.watchedEmoji || '✔️'
            );
        }

        // Build metadata for each item
        const metas = await buildMetas(
            filteredResults, 
            catalogType, 
            parsedConfig.language, 
            parsedConfig.rpdbApiKey, 
            parsedConfig.fanartApiKey, 
            parsedConfig.addWatchedTraktBtn, 
            parsedConfig.hideTraktHistory, 
            parsedConfig.traktUsername,
            origin,
            parsedConfig.tmdbApiKey,
            userAgent
        );

        // Cache control headers
        res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
        res.setHeader('Vary', 'Accept-Encoding');

        // Send response
        res.json({ 
            metas,
            cacheMaxAge: 3600,
            staleRevalidate: 14400, // 4 hours
            staleError: 86400, // 24 hours
        });

    } catch (error) {
        log.error(`Error processing catalog request: ${error.message}`, {
            stack: error.stack,
            params: req.params,
            query: req.query
        });

        if (!res.headersSent) {
            res.status(500).json({ 
                error: 'Internal Server Error',
                message: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    }
});

module.exports = router;