const axios = require('axios');
const { safeRedisCall } = require('../helpers/redis');
const log = require('../helpers/logger');
const addToQueueTMDB = require('../helpers/bottleneck_tmdb');
const { pool } = require('../helpers/db');

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const PREFETCH_PAGE_COUNT = process.env.PREFETCH_PAGE_COUNT ? parseInt(process.env.PREFETCH_PAGE_COUNT, 10) : 5;
const CACHE_CATALOG_CONTENT_DURATION_DAYS = process.env.CACHE_CATALOG_CONTENT_DURATION_DAYS ? parseInt(process.env.CACHE_CATALOG_CONTENT_DURATION_DAYS, 10) : 1;
const CACHE_DURATION_SECONDS = CACHE_CATALOG_CONTENT_DURATION_DAYS * 86400;

const makeRequest = (url, tmdbApiKey = null) => {
    if (tmdbApiKey) {
        url = `${url}${url.includes('?') ? '&' : '?'}api_key=${tmdbApiKey}`;
    }
    
    return new Promise((resolve, reject) => {
        addToQueueTMDB({
            fn: () => axios.get(url)
                .then(response => {
                    log.debug(`API request successful for URL: ${url}`);
                    resolve(response.data);
                })
                .catch(error => {
                    log.error(`Error during API request for URL: ${url} - ${error.message}`);
                    reject(error);
                })
        });
    });
};

const determinePageFromSkip = async (providerId, skip, type, sortBy, ageRange, rating = null, genre = null, year = null, watchRegion = 'no-region', language = 'en') => {
    try {
        if (skip === 0 || skip === null || skip === '') {
            log.debug('Skip is 0 or null, returning page 1');
            return 1;
        }

        const keyPattern = `discover:${providerId}:${type}:${sortBy}:${ageRange}:${rating || 'no-rating'}:${genre || 'no-genre'}:${year || 'no-year'}:${watchRegion}:${language}:page:*:skip:*`;

        const keys = await safeRedisCall('keys', keyPattern);

        if (keys && keys.length > 0) {
            const filteredKeys = keys.filter(key => {
                const skipMatch = key.match(/skip:(\d+)/);
                return skipMatch && parseInt(skipMatch[1], 10) <= skip;
            });

            if (filteredKeys.length > 0) {
                filteredKeys.sort((a, b) => {
                    const skipA = parseInt(a.match(/skip:(\d+)/)[1], 10);
                    const skipB = parseInt(b.match(/skip:(\d+)/)[1], 10);
                    return skipB - skipA;
                });

                const bestMatchKey = filteredKeys[0];
                const cachedEntry = await safeRedisCall('get', bestMatchKey);

                if (cachedEntry) {
                    const parsedEntry = JSON.parse(cachedEntry);
                    log.debug(`Cached Entry: Page ${parsedEntry.page}, Skip ${parsedEntry.skip}`);
                    return parsedEntry.page + 1;
                }
            }
        }

        log.debug(`No cached entry found for skip=${skip}, returning default page`);
        return 1;

    } catch (error) {
        log.error('Error in determinePageFromSkip:', error);
        return 1;
    }
};

const fetchData = async (endpoint, params = {}, tmdbApiKey = null, providerId = null, ageRange = null, rating = null, genre = null, year = null, language = 'en') => {
    if (tmdbApiKey) {
        params.api_key = tmdbApiKey;
    }

    const { skip, type, sort_by: sortBy, watch_region: watchRegion = 'no-region' } = params;

    const page = providerId ? await determinePageFromSkip(providerId, skip, type, sortBy, ageRange, rating, genre, year, watchRegion, language) : 1;

    const { skip: _skip, type: _type, ...queryParamsWithoutSkipAndType } = params;
    const queryParamsWithPage = {
        ...queryParamsWithoutSkipAndType,
        page,
    };

    const queryString = new URLSearchParams(queryParamsWithPage).toString();
    const url = `${TMDB_BASE_URL}${endpoint}?${queryString}`;

    const cacheKey = `discover:${providerId}:${type}:${sortBy}:${ageRange}:${rating || 'no-rating'}:${genre || 'no-genre'}:${year || 'no-year'}:${watchRegion}:${language}:page:${page}:skip:${skip}`;

    const cachedData = await safeRedisCall('get', cacheKey);
    if (cachedData) {
        return JSON.parse(cachedData);
    }

    const data = await makeRequest(url);

    if (data.total_pages >= page) {
        await safeRedisCall('setEx', cacheKey, CACHE_DURATION_SECONDS, JSON.stringify(data));
    }

    if (data.total_pages > page) {
        prefetchNextPages(endpoint, queryParamsWithPage, page, data.total_pages, providerId, ageRange, rating, genre, year, watchRegion, language);
    }

    return data;
};

const prefetchNextPages = async (endpoint, queryParamsWithPage, currentPage, totalPages, providerId, ageRange, rating = 'all', genre = 'all', year = 'all', watchRegion = 'no-region', language = 'en') => {
    const prefetchPromises = [];

    for (let i = 1; i <= PREFETCH_PAGE_COUNT; i++) {
        const nextPage = currentPage + i;
        if (nextPage > totalPages) break;

        const nextSkip = (nextPage - 1) * 20;
        const cacheKey = `discover:${providerId}:${queryParamsWithPage.type}:${queryParamsWithPage.sort_by}:${ageRange}:${rating}:${genre}:${year}:${watchRegion}:${language}:page:${nextPage}:skip:${nextSkip}`;

        const cachedData = await safeRedisCall('get', cacheKey);
        if (!cachedData) {
            prefetchPromises.push(
                (async () => {
                    try {
                        const nextQueryParamsWithPage = { ...queryParamsWithPage, page: nextPage };
                        delete nextQueryParamsWithPage.skip;
                        
                        const nextQueryString = new URLSearchParams(nextQueryParamsWithPage).toString();
                        const nextUrl = `${TMDB_BASE_URL}${endpoint}?${nextQueryString}`;

                        const nextData = await makeRequest(nextUrl);
                        await safeRedisCall('setEx', cacheKey, CACHE_DURATION_SECONDS, JSON.stringify(nextData));

                        log.debug(`Prefetched and stored data for page: ${nextPage}`);
                    } catch (error) {
                        log.warn(`Error prefetching data for page ${nextPage}: ${error.message}`);
                    }
                })()
            );
        }
    }

    await Promise.all(prefetchPromises);
};

const discoverContent = async (type, watchProviders = [], ageRange = null, sortBy = 'popularity.desc', genre = null, tmdbApiKey = null, language = 'en', skip = 0, regions = [], year = null, rating = null) => { 
    const mediaType = type === 'series' ? 'tv' : 'movie';
    const endpoint = `/discover/${mediaType}`;

    const providerId = watchProviders[0];

    const params = {
        with_watch_providers: watchProviders.join(','),
        sort_by: sortBy,
        language,
        skip,
        type: mediaType
    };

    if (regions && regions.length > 0) {
        params.watch_region = regions.join('|');
    }

    if (year) {
        const [startYear, endYear] = year.split('-');
        if (startYear && endYear) {
            if (mediaType === 'movie') {
                params['primary_release_date.gte'] = `${startYear}-01-01`;
                params['primary_release_date.lte'] = `${endYear}-12-31`;
            } else {
                params['first_air_date.gte'] = `${startYear}-01-01`;
                params['first_air_date.lte'] = `${endYear}-12-31`;
            }
        }
    }

    if (rating) {
        const [minRating, maxRating] = rating.split('-');
        if (minRating && maxRating) {
            params['vote_average.gte'] = minRating;
            params['vote_average.lte'] = maxRating;
        }
    }

    if (ageRange) {
        switch(ageRange) {
            case '0-5':
            case '6-11':
                if (mediaType === 'movie') {
                    params.certification_country = 'US';
                    params.certification = 'G';
                    params.without_genres = '27,18,53,80,10752,37,10749,10768,10767,10766,10764,10763,9648,99,36';
                }
                if (mediaType === 'tv') {
                    params.with_genres = '10762';
                }
                break;

            case '12-15':
                if (mediaType === 'movie') {
                    params.certification_country = 'US';
                    params.certification = 'PG';
                }
                if (mediaType === 'tv') {
                    params.with_genres = '16';
                }
                break;

            case '16-17':
                if (mediaType === 'movie') {
                    params.certification_country = 'US';
                    params.certification = 'PG-13';
                }
                break;

            case '18+':
                params.include_adult = true;
                break;
        }
    }

    if (genre) {
        params.with_genres = genre;
    }

    try {
        const results = await fetchData(endpoint, params, tmdbApiKey, providerId, ageRange, rating, genre, year, language);
        return results;
    } catch (error) {
        log.error(`Error in discoverContent: ${error.message}`);
        throw error;
    }
};

const getExternalIds = async (tmdbId, type, apiKey) => {
    const mediaType = type === 'series' ? 'tv' : 'movie';
    const cacheKey = `external_ids:${tmdbId}:${mediaType}`;
    
    try {
        const cachedData = await safeRedisCall('get', cacheKey);
        if (cachedData) {
            const parsed = JSON.parse(cachedData);
            return parsed.imdb_id || null;
        }

        const url = `${TMDB_BASE_URL}/${mediaType}/${tmdbId}/external_ids`;
        const data = await makeRequest(url, apiKey);
        
        if (data) {
            await safeRedisCall('setEx', cacheKey, CACHE_DURATION_SECONDS, JSON.stringify(data));
            return data.imdb_id || null;
        }
        return null;
    } catch (error) {
        log.error(`Error fetching external IDs for TMDB ID ${tmdbId}: ${error.message}`);
        return null;
    }
};

const getContentDetailsById = async (item, type, apiKey, language) => {
    if (!item || !item.id) {
        throw new Error('Invalid content item');
    }

    const tmdbType = type === 'series' ? 'tv' : type;
    const cacheKey = `details:${item.id}:${tmdbType}:${language}`;

    try {
        const cachedData = await safeRedisCall('get', cacheKey);
        if (cachedData) {
            return JSON.parse(cachedData);
        }

        const url = `${TMDB_BASE_URL}/${tmdbType}/${item.id}`;
        const data = await makeRequest(url, apiKey);

        if (data) {
            await safeRedisCall('setEx', cacheKey, CACHE_DURATION_SECONDS, JSON.stringify(data));
            return {
                ...item,
                title: data.title || data.name,
                tagline: data.tagline || '',
                rating: data.vote_average,
                vote_count: data.vote_count,
                released: data.release_date || data.first_air_date
            };
        }
        return item;
    } catch (error) {
        log.error(`Error fetching content details: ${error.message}`);
        return item;
    }
};

const getRecommendationsFromTmdb = async (tmdbId, type, apiKey, language) => {
    try {
        const tmdbType = type === 'series' ? 'tv' : type;
        const cacheKey = `recommendations:${tmdbId}:${tmdbType}:${language}`;

        const cachedData = await safeRedisCall('get', cacheKey);
        if (cachedData) {
            return JSON.parse(cachedData);
        }

        const url = `${TMDB_BASE_URL}/${tmdbType}/${tmdbId}/recommendations`;
        const data = await makeRequest(url, apiKey);

        if (data && data.results) {
            await safeRedisCall('setEx', cacheKey, CACHE_DURATION_SECONDS, JSON.stringify(data.results));
            return data.results;
        }
        return [];
    } catch (error) {
        log.error(`Error fetching recommendations: ${error.message}`);
        return [];
    }
};

const getSimilarContentFromTmdb = async (tmdbId, type, apiKey, language) => {
    try {
        const tmdbType = type === 'series' ? 'tv' : type;
        const cacheKey = `similar:${tmdbId}:${tmdbType}:${language}`;

        const cachedData = await safeRedisCall('get', cacheKey);
        if (cachedData) {
            return JSON.parse(cachedData);
        }

        const url = `${TMDB_BASE_URL}/${tmdbType}/${tmdbId}/similar`;
        const data = await makeRequest(url, apiKey);

        if (data && data.results) {
            await safeRedisCall('setEx', cacheKey, CACHE_DURATION_SECONDS, JSON.stringify(data.results));
            return data.results;
        }
        return [];
    } catch (error) {
        log.error(`Error fetching similar content: ${error.message}`);
        return [];
    }
};

const checkGenresExistForLanguage = async (language) => {
    try {
        const result = await pool.query(
            `SELECT 1 FROM genres WHERE language = $1 LIMIT 1`,
            [language]
        );
        return result.rows.length > 0;
    } catch (err) {
        log.error(`Error checking genres: ${err.message}`);
        throw err;
    }
};

module.exports = {
    makeRequest,
    fetchData,
    discoverContent,
    getExternalIds,
    getContentDetailsById,
    getRecommendationsFromTmdb,
    getSimilarContentFromTmdb,
    checkGenresExistForLanguage
};
