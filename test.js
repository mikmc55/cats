require('dotenv').config();
const axios = require('axios');

async function makeRequest(url, apiKey) {
    try {
        const response = await axios.get(`${url}${url.includes('?') ? '&' : '?'}api_key=${apiKey}`);
        return response.data;
    } catch (error) {
        console.error(`Error making request to ${url}:`, error.message);
        if (error.response && error.response.data) {
            console.error('Error details:', error.response.data);
        }
        throw error;
    }
}

async function testTMDBEndpoints(apiKey) {
    try {
        // Test movie discover endpoint
        console.log("\n=== Testing Movie Discover ===");
        const movieResponse = await makeRequest(
            'https://api.themoviedb.org/3/discover/movie?sort_by=popularity.desc',
            apiKey
        );
        console.log("\nMovie Response Structure:", Object.keys(movieResponse));
        console.log("\nSample Movie Result Structure:", Object.keys(movieResponse.results[0]));
        console.log("\nSample Movie Full Data:", JSON.stringify(movieResponse.results[0], null, 2));

        // Test TV series discover endpoint
        console.log("\n=== Testing TV Series Discover ===");
        const tvResponse = await makeRequest(
            'https://api.themoviedb.org/3/discover/tv?sort_by=popularity.desc',
            apiKey
        );
        console.log("\nTV Response Structure:", Object.keys(tvResponse));
        console.log("\nSample TV Result Structure:", Object.keys(tvResponse.results[0]));
        console.log("\nSample TV Full Data:", JSON.stringify(tvResponse.results[0], null, 2));

    } catch (error) {
        console.error("Error during testing:", error.message);
    }
}

// Get API key from environment variable
const TMDB_API_KEY = "96ca5e1179f107ab7af156b0a3ae9ca5";

if (!TMDB_API_KEY) {
    console.error("Error: TMDB_API_KEY environment variable is not set");
    process.exit(1);
}

testTMDBEndpoints(TMDB_API_KEY);
