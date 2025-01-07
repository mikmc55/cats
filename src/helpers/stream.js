const log = require('./logger');
const { getContentDetailsById, getImdbId } = require('../api/tmdb');

const prepareStreams = async (content, apiKey, language, showRating, showTagline, userAgent = '', type) => {
    if (!Array.isArray(content)) {
        throw new TypeError('Expected content to be an array');
    }

    const today = new Date();

    try {
        // Fetch detailed content information for each item
        const contentDetails = await Promise.all(
            content.map(item => getContentDetailsById(item, type, apiKey, language))
        );

        // Get IMDb IDs for released content
        const imdbIdResults = await Promise.all(contentDetails.map(async item => {
            const releaseDate = type === 'movie' ? item.release_date : item.first_air_date;
            return (releaseDate && new Date(releaseDate) <= today) 
                ? getImdbId(item.id, type, apiKey, language) 
                : null;
        }));

        const preparedContent = contentDetails.map((item, index) => {
            if (!item) {
                log.warn('Received null or undefined content item');
                return null;
            }

            try {
                // Handle rating display
                const rating = showRating ? (item.vote_average?.toFixed(1) || 'N/A') : '';
                const ratingValue = parseFloat(rating);
                const emoji = ratingValue > 0 ? ratingToEmoji(ratingValue) : '';
                const ratingText = ratingValue > 0 ? `${rating} ${emoji}` : '';
                
                // Handle vote count display
                const voteCountText = showRating && item.vote_count 
                    ? ` (${formatVoteCount(item.vote_count)} 👥)` 
                    : '';

                // Handle release date and external URL
                const releaseDate = type === 'movie' ? item.release_date : item.first_air_date;
                const releaseYear = releaseDate ? releaseDate.split('-')[0] : 'TMDB';
                
                const externalUrl = releaseDate
                    ? (new Date(releaseDate) > today
                        ? `https://www.themoviedb.org/${type}/${item.id}`
                        : userAgent.includes('Stremio')
                            ? `stremio:///detail/${type}/${imdbIdResults[index] || ''}`
                            : `https://web.stremio.com/#/detail/${type}/${imdbIdResults[index] || ''}`)
                    : `https://www.themoviedb.org/${type}/${item.id}`;

                // Build title with optional components
                const newLine = '\n';
                const contentTitle = type === 'movie' ? item.title : item.name;
                const taglineText = showTagline && item.tagline ? `${newLine}${item.tagline}` : '';
                
                const title = [
                    contentTitle,
                    ratingText && newLine + ratingText,
                    voteCountText,
                    taglineText
                ].filter(Boolean).join('');

                // Build stream object
                return {
                    name: releaseYear,
                    title: title,
                    externalUrl: externalUrl,
                    ...(rating && { rating }),
                    ...(ratingValue && { ratingValue }),
                    ...(emoji && { emoji }),
                    ...(ratingText && { ratingText }),
                    ...(voteCountText && { voteCountText }),
                    // Additional metadata
                    originalTitle: type === 'movie' ? item.original_title : item.original_name,
                    originalLanguage: item.original_language,
                    adult: item.adult,
                    popularity: item.popularity,
                    releaseDate: releaseDate
                };

            } catch (error) {
                log.error(`Error preparing stream for item ${item?.id}: ${error.message}`);
                return null;
            }
        });

        // Filter out any null results and return
        return preparedContent.filter(Boolean);

    } catch (error) {
        log.error(`Error in prepareStreams: ${error.message}`);
        throw error;
    }
};

const formatVoteCount = (voteCount) => {
    try {
        const count = parseInt(voteCount);
        if (isNaN(count)) return '0';

        if (count >= 1000000) {
            return `${(count / 1000000).toFixed(1)}M`;
        }
        if (count >= 1000) {
            return `${(count / 1000).toFixed(1)}k`;
        }
        return count.toString();
    } catch (error) {
        log.error(`Error formatting vote count: ${error.message}`);
        return '0';
    }
};

const ratingToEmoji = (rating) => {
    try {
        const numericRating = parseFloat(rating);
        if (isNaN(numericRating)) return '';

        if (numericRating >= 9) return '🏆';
        if (numericRating >= 8) return '🔥';
        if (numericRating >= 6) return '⭐';
        if (numericRating >= 5) return '😐';
        return '🥱';
    } catch (error) {
        log.error(`Error converting rating to emoji: ${error.message}`);
        return '';
    }
};

module.exports = {
    prepareStreams,
    formatVoteCount,
    ratingToEmoji
};