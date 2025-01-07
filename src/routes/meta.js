const express = require('express');
const log = require('../helpers/logger');
const { getContentFromImdbId } = require('../api/tmdb');
const { getFanartPoster } = require('../api/fanart');
const { getPosterUrl } = require('../helpers/catalog');

const router = express.Router();

router.get("/:configParameters?/meta/:type/:id.json", async (req, res) => {
    const { id, configParameters, type } = req.params;
    
    log.debug(`Meta request received for ${type} with id ${id}`);

    try {
        const config = configParameters ? JSON.parse(decodeURIComponent(configParameters)) : {};
        const { tmdbApiKey, language = 'en', rpdbApiKey, fanartApiKey } = config;

        if (!tmdbApiKey) {
            return res.status(400).json({ error: 'TMDB API key is required' });
        }

        // Clean the ID (remove 'tt' prefix if present)
        const cleanId = id.startsWith('tt') ? id.substring(2) : id;
        const content = await getContentFromImdbId(cleanId, tmdbApiKey, language);

        if (!content) {
            log.warn(`No content found for ID: ${cleanId}`);
            return res.status(404).json({ error: 'Content not found' });
        }

        let posterUrl = await getPosterUrl({ id: content.tmdbId, poster_path: content.poster_path }, type, language, rpdbApiKey);
        let logo = null;

        if (fanartApiKey) {
            logo = await getFanartPoster(content.tmdbId, language, fanartApiKey);
        }

        const meta = {
            id: `tmdb:${content.tmdbId}`,
            type: content.type,
            name: content.title,
            poster: posterUrl,
            background: `https://image.tmdb.org/t/p/original${content.backdrop_path}`,
            logo: logo || null,
            description: content.overview,
            releaseInfo: content.release_date || content.first_air_date ? (content.release_date || content.first_air_date).split('-')[0] : null,
            imdbRating: content.vote_average ? content.vote_average.toFixed(1) : null,
            genres: content.genres ? content.genres.map(g => g.name) : [],
            runtime: content.runtime || (content.episode_run_time ? content.episode_run_time[0] : null),
            cast: content.cast ? content.cast.slice(0, 10).map(c => c.name) : [],
            director: content.crew ? content.crew.filter(c => c.job === 'Director').map(c => c.name) : [],
            country: content.production_countries ? content.production_countries.map(c => c.name) : [],
            videos: content.videos ? content.videos.results.filter(v => v.site === 'YouTube').map(v => ({
                id: v.key,
                title: v.name,
                thumbnail: `https://img.youtube.com/vi/${v.key}/0.jpg`
            })) : []
        };

        res.json({ meta });
    } catch (error) {
        log.error(`Error processing meta request: ${error.message}`);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;