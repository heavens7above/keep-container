const express = require('express');
const { Storage } = require('@google-cloud/storage');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');

const app = express();
const port = process.env.PORT || 8080;
const storage = new Storage();

const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Quote categories for variety
const quoteCategories = [
    "wisdom", "motivation", "reflection", "creativity",
    "minimalism", "productivity", "mindfulness", "growth"
];

/**
 * Generate a unique quote using Gemini AI
 */
async function generateQuote() {
    try {
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0.8,
                topP: 0.9,
                topK: 40,
                maxOutputTokens: 100,
            }
        });

        const category = quoteCategories[Math.floor(Math.random() * quoteCategories.length)];
        const today = new Date().toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric'
        });

        const prompt = `
Generate a single, original, thought-provoking quote for ${today}.
Theme: ${category}
Requirements:
- Be insightful but concise (max 2 lines)
- Sound like a philosopher or wise observer
- Avoid clichés and overused phrases
- No hashtags, no emojis, no markdown
- Format: Quote text on one line, then a dash and the theme on the next line
Example: "The river carves its own path without apology." - Natural Wisdom
`;

        const result = await model.generateContent(prompt);
        const quote = result.response.text().trim();

        // Clean up any extra formatting
        const cleanQuote = quote.replace(/[""]/g, '').replace(/\n+/g, '\n');
        console.log(`Generated quote: ${cleanQuote}`);
        return cleanQuote;
    } catch (error) {
        console.error('Error generating quote:', error);
        // Fallback quotes
        const fallbackQuotes = [
            "The quiet mind hears what the loud world misses. - Daily Reflection",
            "We don't see things as they are; we see them as we are. - Anais Nin",
            "Growth requires both roots and reach. - Personal Development"
        ];
        return fallbackQuotes[Math.floor(Math.random() * fallbackQuotes.length)];
    }
}

/**
 * Extract and load Chrome profile
 */
async function setupChromeProfile() {
    const bucketName = process.env.BUCKET_NAME || 'keep-profile-store';
    const zipPath = '/tmp/profile.zip';
    const profileDir = '/tmp/profile';

    try {
        console.log('Downloading Chrome profile from Cloud Storage...');

        // Ensure profile directory exists
        if (!fs.existsSync('/tmp')) {
            fs.mkdirSync('/tmp', { recursive: true });
        }

        // Download profile zip
        await storage.bucket(bucketName)
            .file('profile.zip')
            .download({ destination: zipPath });

        console.log('Extracting Chrome profile...');

        // Clean existing profile directory
        if (fs.existsSync(profileDir)) {
            fs.rmSync(profileDir, { recursive: true, force: true });
        }
        fs.mkdirSync(profileDir, { recursive: true });

        // Extract zip
        await new Promise((resolve, reject) => {
            fs.createReadStream(zipPath)
                .pipe(unzipper.Extract({ path: profileDir }))
                .on('close', resolve)
                .on('error', reject);
        });

        console.log('Chrome profile ready');
        return profileDir;
    } catch (error) {
        console.error('Error setting up Chrome profile:', error);
        throw error;
    }
}

/**
 * Add quote to Google Keep
 */
async function addQuoteToKeep(quote) {
    let browser = null;
    let profileDir = null;

    try {
        // Setup Chrome profile
        profileDir = await setupChromeProfile();

        // Launch browser with persistent context
        console.log('Launching browser...');
        browser = await chromium.launchPersistentContext(profileDir, {
            headless: true,  // Set to false for debugging
            viewport: { width: 1280, height: 800 },
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer'
            ],
            ignoreDefaultArgs: ['--disable-component-extensions-with-background-pages']
        });

        const page = await browser.newPage();

        // Navigate to Google Keep
        console.log('Navigating to Google Keep...');
        await page.goto('https://keep.google.com', {
            waitUntil: 'networkidle',
            timeout: 30000
        });

        // Wait for page to load and check login status
        await page.waitForTimeout(5000);

        // Check if we're logged in by looking for the "Create new note" button
        const isLoggedIn = await page.evaluate(() => {
            return document.querySelector('div[role="button"][aria-label*="Take"]') !== null ||
                document.querySelector('div[aria-label="Create new note"]') !== null ||
                document.querySelector('textarea[aria-label="Note"]') !== null;
        });

        if (!isLoggedIn) {
            console.log('Not logged in. Please check your Chrome profile is properly authenticated.');
            // Take screenshot for debugging
            await page.screenshot({ path: '/tmp/login-status.png' });
            throw new Error('Not logged into Google Keep');
        }

        console.log('Logged in successfully. Creating note...');

        // Click to create new note (multiple selectors for robustness)
        const selectors = [
            'div[aria-label="Create new note"]',
            'div[role="button"][aria-label*="Take"]',
            'div[role="button"]:has-text("Take a note")',
            'textarea[aria-label="Note"]'
        ];

        let noteCreated = false;
        for (const selector of selectors) {
            try {
                const element = await page.$(selector);
                if (element) {
                    await element.click();
                    await page.waitForTimeout(1000);
                    noteCreated = true;
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        if (!noteCreated) {
            // Fallback: press 'c' key (Google Keep shortcut for new note)
            await page.keyboard.press('c');
            await page.waitForTimeout(1000);
        }

        // Type the quote
        console.log('Typing quote:', quote);
        await page.keyboard.type(quote);
        await page.waitForTimeout(1000);

        // Add label/tag (optional)
        const labels = ['Daily Quote', 'AI Generated', 'Inspiration'];
        const labelToAdd = labels[Math.floor(Math.random() * labels.length)];

        try {
            // Try to add label using keyboard shortcut (Shift+L in Google Keep)
            await page.keyboard.down('Shift');
            await page.keyboard.press('l');
            await page.keyboard.up('Shift');
            await page.waitForTimeout(500);

            await page.keyboard.type(labelToAdd);
            await page.waitForTimeout(500);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(1000);
        } catch (error) {
            console.log('Could not add label (non-critical)');
        }

        // Save note (press Escape)
        await page.keyboard.press('Escape');
        await page.waitForTimeout(3000);

        // Take screenshot for verification
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        await page.screenshot({
            path: `/tmp/keep-success-${timestamp}.png`,
            fullPage: false
        });

        console.log('Quote successfully added to Google Keep!');
        return { success: true, quote: quote };

    } catch (error) {
        console.error('Error adding quote to Keep:', error);

        // Take error screenshot
        if (browser) {
            const pages = await browser.pages();
            if (pages.length > 0) {
                await pages[0].screenshot({
                    path: '/tmp/keep-error.png',
                    fullPage: true
                });
            }
        }

        throw error;
    } finally {
        if (browser) {
            await browser.close();
        }
        // Cleanup
        try {
            if (profileDir && fs.existsSync(profileDir)) {
                fs.rmSync(profileDir, { recursive: true, force: true });
            }
            if (fs.existsSync('/tmp/profile.zip')) {
                fs.unlinkSync('/tmp/profile.zip');
            }
        } catch (cleanupError) {
            console.warn('Cleanup warning:', cleanupError.message);
        }
    }
}

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'Google Keep Quote Bot'
    });
});

/**
 * Manual trigger endpoint
 */
app.get('/add-quote', async (req, res) => {
    try {
        const quote = await generateQuote();
        const result = await addQuoteToKeep(quote);

        res.json({
            success: true,
            message: 'Quote added to Google Keep',
            quote: quote,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error in /add-quote:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

/**
 * Scheduled job endpoint (for Cloud Scheduler)
 */
app.post('/scheduled-quote', async (req, res) => {
    try {
        console.log('Running scheduled quote job...');
        const quote = await generateQuote();
        await addQuoteToKeep(quote);

        res.json({
            success: true,
            message: 'Scheduled quote added successfully',
            quote: quote
        });
    } catch (error) {
        console.error('Scheduled job failed:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Main endpoint
 */
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Google Keep Quote Bot</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 40px; }
                .container { max-width: 800px; margin: 0 auto; }
                .button { 
                    display: inline-block; 
                    padding: 10px 20px; 
                    background: #4285f4; 
                    color: white; 
                    text-decoration: none;
                    border-radius: 4px;
                    margin: 10px;
                }
                .endpoint { background: #f5f5f5; padding: 10px; margin: 10px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Google Keep Quote Bot 🤖</h1>
                <p>Automatically add AI-generated quotes to Google Keep</p>
                
                <h2>Endpoints:</h2>
                <div class="endpoint">
                    <strong>GET /health</strong> - Health check
                </div>
                <div class="endpoint">
                    <strong>GET /add-quote</strong> - Manually trigger quote creation
                </div>
                <div class="endpoint">
                    <strong>POST /scheduled-quote</strong> - For scheduled jobs (Cloud Scheduler)
                </div>
                
                <h2>Actions:</h2>
                <a href="/health" class="button">Check Health</a>
                <a href="/add-quote" class="button">Add Quote Now</a>
                
                <h2>Setup Instructions:</h2>
                <ol>
                    <li>Export your Chrome profile to Google Cloud Storage as profile.zip</li>
                    <li>Set environment variables: GEMINI_API_KEY, BUCKET_NAME</li>
                    <li>Schedule /scheduled-quote endpoint to run daily</li>
                </ol>
            </div>
        </body>
        </html>
    `);
});

// Start server
app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log(`📝 Health check: http://localhost:${port}/health`);
    console.log(`✏️  Manual trigger: http://localhost:${port}/add-quote`);
});

module.exports = app;
