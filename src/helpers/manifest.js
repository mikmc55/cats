const { pool } = require('./db');
const log = require('../helpers/logger');
const { checkGenresExistForLanguage, fetchAndStoreGenres } = require('../api/tmdb');

const addonLogoUrl = `${process.env.BASE_URL}/assets/logo.png`;

const manifestTemplate = {
    id: 'community.streamingcatalogproviders',
    version: '1.3.0',
    logo: addonLogoUrl,
    name: 'Streaming Catalog Providers',
    description: 'Catalog from TMDB streaming providers.',
    resources: ['catalog', 'meta'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    // Add meta schema
    meta: {
        movie: {
            type: 'movie',
            idPrefixes: ['tt']  // only responds to imdb ids starting with 'tt'
        },
        series: {
            type: 'series',
            idPrefixes: ['tt']
        }
    },
    behaviorHints: {
        configurable: true,
        configurationRequired: false,
    }
};

const getProvider = async (providerId) => {
    try {
        const result = await pool.query("SELECT * FROM providers WHERE provider_id = $1", [providerId]);
        const row = result.rows[0];
        return row || null;
    } catch (err) {
        throw err;
    }
};

const getGenres = async (type, language) => {
    try {
        const result = await pool.query(
            "SELECT genre_name FROM genres WHERE media_type = $1 AND language = $2", 
            [type, language]
        );
        return result.rows.map(row => row.genre_name);
    } catch (err) {
        throw err;
    }
};

const getCurrentYear = () => new Date().getFullYear();

const generateYearIntervals = (startYear = 1880, endYear = getCurrentYear(), interval = 4) => {
    const intervals = [];
    endYear = Math.max(endYear, startYear);

    for (let year = endYear; year >= startYear; year -= interval) {
        const nextYear = Math.max(year - interval + 1, startYear);
        intervals.push(`${nextYear}-${year}`);
    }

    const [firstStart, firstEnd] = intervals.length 
        ? intervals[intervals.length - 1].split('-').map(Number) 
        : [startYear, endYear];

    if (firstStart > startYear) {
        intervals[intervals.length - 1] = `${startYear}-${firstEnd}`;
    }

    return intervals.length ? intervals : [`${startYear}-${endYear}`];
};    

const generateManifest = async (config) => {
    try {
        const { providers, language, tmdbApiKey, ageRange, additionalContent, popularCatalogTitle, newCatalogTitle } = config;

        if (!Array.isArray(providers) || !providers.length) throw new Error('No providers specified.');

        if (language && !(await checkGenresExistForLanguage(language))) {
            log.debug(`Fetching genres for language: ${language}`);
            await fetchAndStoreGenres(language, tmdbApiKey);
        }

        const [movieGenres, seriesGenres] = await Promise.all([
            getGenres('movie', language),
            getGenres('tv', language)
        ]);

        const genreOptions = (genres) => genres.map(genre => genre);
        const yearIntervals = generateYearIntervals();
        const isKidsMode = ageRange && ageRange !== '18+';

        const providerInfo = await Promise.all(providers.map(providerId => getProvider(providerId)));
        const catalogs = providerInfo.flatMap(provider => {
            if (!provider) return [];

            const baseCatalogs = [
                { type: 'movie', idSuffix: 'movies', namePrefix: 'Movies' },
                { type: 'series', idSuffix: 'series', namePrefix: 'Series' }
            ];

            return baseCatalogs.flatMap(base => {
                return [
                    {
                        type: base.type,
                        id: `tmdb-discover-${base.idSuffix}-popular-${provider.provider_id}`,
                        name: `${popularCatalogTitle || 'Popular'} - ${provider.provider_name}`,
                        extra: [
                            { name: 'genre', isRequired: false, options: genreOptions(base.type === 'movie' ? movieGenres : seriesGenres) },
                            { name: "rating", options: ["8-10", "6-8", "4-6", "2-4", "0-2"], isRequired: false },
                            { name: "year", options: yearIntervals, isRequired: false },
                            { name: 'skip', isRequired: false },
                            { name: 'ageRange', value: isKidsMode ? ageRange : '18+' }
                        ]
                    },
                    {
                        type: base.type,
                        id: `tmdb-discover-${base.idSuffix}-new-${provider.provider_id}`,
                        name: `${newCatalogTitle || 'New'} - ${provider.provider_name}`,
                        extra: [
                            { name: 'genre', isRequired: false, options: genreOptions(base.type === 'movie' ? movieGenres : seriesGenres) },
                            { name: "rating", options: ["8-10", "6-8", "4-6", "2-4", "0-2"], isRequired: false },
                            { name: "year", options: yearIntervals, isRequired: false },
                            { name: 'skip', isRequired: false },
                            { name: 'ageRange', value: isKidsMode ? ageRange : '18+' }
                        ]
                    }
                ];
            });
        });

        const resources = ['catalog', 'meta'];
        if (additionalContent && additionalContent.trim() !== '') {
            resources.push('stream');
        }

        const manifest = {
            ...manifestTemplate,
            catalogs: catalogs,
            resources: resources,
            meta: manifestTemplate.meta  // Include the meta schema
        };

        return manifest;
    } catch (error) {
        console.error('Error generating manifest:', error);
        throw error;
    }
};

module.exports = generateManifest;
