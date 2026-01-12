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

// Configuration
const CONFIG = {
    BUCKET_NAME: process.env.BUCKET_NAME || 'keep-profile-store',
    LOG_FILE: '/tmp/quote-bot.log',
    MAX_RETRIES: 3,
    QUOTE_CATEGORIES: [
        "wisdom", "motivation", "reflection", "creativity",
        "minimalism", "productivity", "mindfulness", "growth"
    ],
    LABELS: ['Daily Quote', 'AI Generated', 'Inspiration']
};

// ==================== UTILITY FUNCTIONS ====================

/**
 * Enhanced logging system
 */
class Logger {
    static log(message, level = 'INFO') {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${level}] ${message}\n`;
        
        console.log(logMessage.trim());
        
        try {
            fs.appendFileSync(CONFIG.LOG_FILE, logMessage);
        } catch (e) {
            console.error('Failed to write log:', e.message);
        }
    }

    static error(message, error = null) {
        this.log(`${message}${error ? `: ${error.message}` : ''}`, 'ERROR');
        if (error?.stack) {
            this.log(`Stack: ${error.stack}`, 'ERROR');
        }
    }

    static warn(message) {
        this.log(message, 'WARN');
    }

    static info(message) {
        this.log(message, 'INFO');
    }

    static debug(message) {
        if (process.env.NODE_ENV === 'development') {
            this.log(message, 'DEBUG');
        }
    }
}

// ==================== CORE FUNCTIONS ====================

/**
 * Generate unique quote using Gemini AI with retry logic
 */
async function generateQuote(retryCount = 0) {
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

        const category = CONFIG.QUOTE_CATEGORIES[Math.floor(Math.random() * CONFIG.QUOTE_CATEGORIES.length)];
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

        Logger.info(`Generating quote (attempt ${retryCount + 1}) with theme: ${category}`);
        const result = await model.generateContent(prompt);
        const quote = result.response.text().trim();

        const cleanQuote = quote.replace(/[""]/g, '').replace(/\n+/g, '\n');
        Logger.info(`Generated quote: ${cleanQuote.substring(0, 100)}...`);
        return cleanQuote;

    } catch (error) {
        if (retryCount < CONFIG.MAX_RETRIES) {
            Logger.warn(`Quote generation failed, retrying... (${retryCount + 1}/${CONFIG.MAX_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
            return generateQuote(retryCount + 1);
        }
        
        Logger.error('Failed to generate quote after retries:', error);
        
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
 * Setup Chrome profile with error handling
 */
async function setupChromeProfile() {
    const zipPath = '/tmp/profile.zip';
    const profileDir = '/tmp/profile';

    try {
        Logger.info('Setting up Chrome profile...');

        // Ensure directories exist
        if (!fs.existsSync('/tmp')) {
            fs.mkdirSync('/tmp', { recursive: true });
        }

        // Clean previous profile
        if (fs.existsSync(profileDir)) {
            fs.rmSync(profileDir, { recursive: true, force: true });
        }

        // Download profile from GCS
        Logger.info(`Downloading profile from bucket: ${CONFIG.BUCKET_NAME}`);
        await storage.bucket(CONFIG.BUCKET_NAME)
            .file('profile.zip')
            .download({ destination: zipPath });

        if (!fs.existsSync(zipPath)) {
            throw new Error('Failed to download profile.zip');
        }

        // Extract profile
        Logger.info('Extracting Chrome profile...');
        fs.mkdirSync(profileDir, { recursive: true });

        await new Promise((resolve, reject) => {
            fs.createReadStream(zipPath)
                .pipe(unzipper.Extract({ path: profileDir }))
                .on('close', resolve)
                .on('error', reject);
        });

        // Verify extraction
        const profileFiles = fs.readdirSync(profileDir);
        if (profileFiles.length === 0) {
            throw new Error('Profile extraction failed - empty directory');
        }

        Logger.info(`Chrome profile ready (${profileFiles.length} files)`);
        return profileDir;

    } catch (error) {
        Logger.error('Chrome profile setup failed:', error);
        throw error;
    }
}

/**
 * Browser automation with comprehensive error handling
 */
async function addQuoteToKeep(quote) {
    let browser = null;
    let profileDir = null;
    let screenshotPath = null;

    try {
        // Setup profile
        profileDir = await setupChromeProfile();

        // Launch browser with optimized settings
        Logger.info('Launching browser...');
        browser = await chromium.launchPersistentContext(profileDir, {
            headless: process.env.NODE_ENV === 'production',
            viewport: { width: 1280, height: 800 },
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-blink-features=AutomationControlled'
            ],
            ignoreDefaultArgs: ['--disable-component-extensions-with-background-pages'],
            timeout: 60000
        });

        const page = await browser.newPage();
        
        // Remove webdriver flag
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false
            });
        });

        // Navigate to Google Keep
        Logger.info('Navigating to Google Keep...');
        await page.goto('https://keep.google.com', {
            waitUntil: 'networkidle',
            timeout: 60000
        });

        // Wait for page to load
        await page.waitForTimeout(5000);

        // Check login status
        Logger.info('Checking login status...');
        const isLoggedIn = await page.evaluate(() => {
            return document.querySelector('div[role="button"][aria-label*="Take"]') !== null ||
                   document.querySelector('div[aria-label="Create new note"]') !== null ||
                   document.querySelector('textarea[aria-label="Note"]') !== null ||
                   document.querySelector('div[aria-label="Take a note"]') !== null;
        });

        if (!isLoggedIn) {
            screenshotPath = `/tmp/login-failed-${Date.now()}.png`;
            await page.screenshot({ path: screenshotPath, fullPage: true });
            throw new Error('Not logged into Google Keep. Check profile authentication.');
        }

        Logger.info('Successfully logged in to Google Keep');

        // Create new note
        Logger.info('Creating new note...');
        const selectors = [
            'div[aria-label="Create new note"]',
            'div[role="button"][aria-label*="Take"]',
            'div[role="button"][aria-label="Take a note"]',
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
                    Logger.debug(`Clicked selector: ${selector}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        if (!noteCreated) {
            // Fallback to keyboard shortcut
            await page.keyboard.press('c');
            await page.waitForTimeout(1000);
            Logger.info('Used keyboard shortcut to create note');
        }

        // Type the quote
        Logger.info(`Typing quote: ${quote.substring(0, 50)}...`);
        await page.keyboard.type(quote);
        await page.waitForTimeout(1000);

        // Add label (optional)
        try {
            const label = CONFIG.LABELS[Math.floor(Math.random() * CONFIG.LABELS.length)];
            await page.keyboard.down('Shift');
            await page.keyboard.press('l');
            await page.keyboard.up('Shift');
            await page.waitForTimeout(500);
            await page.keyboard.type(label);
            await page.waitForTimeout(500);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(1000);
            Logger.info(`Added label: ${label}`);
        } catch (error) {
            Logger.warn('Could not add label (non-critical)');
        }

        // Save note
        await page.keyboard.press('Escape');
        await page.waitForTimeout(3000);

        // Verify note was created
        await page.waitForTimeout(2000);
        const noteExists = await page.evaluate(() => {
            const notes = document.querySelectorAll('div[role="article"]');
            return notes.length > 0;
        });

        if (!noteExists) {
            throw new Error('Note creation may have failed - no notes detected');
        }

        // Success screenshot
        screenshotPath = `/tmp/keep-success-${Date.now()}.png`;
        await page.screenshot({ 
            path: screenshotPath,
            fullPage: false 
        });

        Logger.info('✓ Quote successfully added to Google Keep!');
        return { 
            success: true, 
            quote: quote,
            screenshot: screenshotPath
        };

    } catch (error) {
        Logger.error('Failed to add quote to Keep:', error);
        
        // Take error screenshot if page exists
        if (browser) {
            try {
                const pages = await browser.pages();
                if (pages.length > 0) {
                    screenshotPath = `/tmp/keep-error-${Date.now()}.png`;
                    await pages[0].screenshot({ 
                        path: screenshotPath,
                        fullPage: true 
                    });
                    Logger.info(`Error screenshot saved: ${screenshotPath}`);
                }
            } catch (screenshotError) {
                Logger.warn('Could not take error screenshot:', screenshotError);
            }
        }
        
        throw error;
        
    } finally {
        // Cleanup browser
        if (browser) {
            try {
                await browser.close();
                Logger.debug('Browser closed successfully');
            } catch (closeError) {
                Logger.warn('Error closing browser:', closeError);
            }
        }
        
        // Cleanup profile
        try {
            if (profileDir && fs.existsSync(profileDir)) {
                fs.rmSync(profileDir, { recursive: true, force: true });
                Logger.debug('Cleaned up profile directory');
            }
            if (fs.existsSync('/tmp/profile.zip')) {
                fs.unlinkSync('/tmp/profile.zip');
            }
        } catch (cleanupError) {
            Logger.warn('Cleanup warning:', cleanupError);
        }
    }
}

// ==================== API ENDPOINTS ====================

// JSON middleware
app.use(express.json());

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'Google Keep Quote Bot',
        version: '2.0.0',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        environment: {
            nodeEnv: process.env.NODE_ENV,
            hasGeminiKey: !!process.env.GEMINI_API_KEY,
            bucketName: CONFIG.BUCKET_NAME
        }
    };
    
    res.json(health);
});

/**
 * Debug endpoint
 */
app.get('/debug', async (req, res) => {
    try {
        const debugInfo = {
            timestamp: new Date().toISOString(),
            environment: {
                GEMINI_API_KEY: process.env.GEMINI_API_KEY ? 'SET' : 'MISSING',
                BUCKET_NAME: CONFIG.BUCKET_NAME,
                NODE_ENV: process.env.NODE_ENV,
                PORT: process.env.PORT
            },
            system: {
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                cwd: process.cwd(),
                platform: process.platform
            },
            files: {
                tmpExists: fs.existsSync('/tmp'),
                canWrite: false,
                logFileExists: fs.existsSync(CONFIG.LOG_FILE)
            }
        };

        // Test file writing
        const testFile = '/tmp/debug-test.txt';
        try {
            fs.writeFileSync(testFile, 'Test write at ' + new Date().toISOString());
            debugInfo.files.canWrite = fs.existsSync(testFile);
            fs.unlinkSync(testFile);
        } catch (writeError) {
            debugInfo.files.writeError = writeError.message;
        }

        // Test Gemini API
        try {
            const testQuote = await generateQuote();
            debugInfo.gemini = { 
                status: 'OK', 
                testQuote: testQuote.substring(0, 80) + '...' 
            };
        } catch (geminiError) {
            debugInfo.gemini = { 
                status: 'ERROR', 
                error: geminiError.message 
            };
        }

        // Test Cloud Storage
        try {
            const [buckets] = await storage.getBuckets();
            debugInfo.storage = { 
                status: 'OK', 
                bucketCount: buckets.length,
                buckets: buckets.slice(0, 3).map(b => b.name) // First 3 buckets
            };
        } catch (storageError) {
            debugInfo.storage = { 
                status: 'ERROR', 
                error: storageError.message 
            };
        }

        res.json(debugInfo);
    } catch (error) {
        res.status(500).json({ 
            error: error.message, 
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined 
        });
    }
});

/**
 * Manual trigger endpoint
 */
app.get('/add-quote', async (req, res) => {
    const jobId = `manual-${Date.now()}`;
    Logger.info(`[${jobId}] Manual quote requested`);
    
    try {
        const quote = await generateQuote();
        Logger.info(`[${jobId}] Quote generated, adding to Keep...`);
        
        const result = await addQuoteToKeep(quote);
        
        Logger.info(`[${jobId}] Successfully added quote to Keep`);
        
        res.json({
            success: true,
            jobId: jobId,
            message: 'Quote added to Google Keep',
            quote: quote,
            timestamp: new Date().toISOString(),
            result: result
        });
        
    } catch (error) {
        Logger.error(`[${jobId}] Failed to add quote:`, error);
        
        res.status(500).json({
            success: false,
            jobId: jobId,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * Scheduled job endpoint (for Cloud Scheduler)
 */
app.post('/scheduled-quote', async (req, res) => {
    const jobId = `scheduled-${Date.now()}`;
    Logger.info(`[${jobId}] Scheduled job triggered from Cloud Scheduler`);
    
    try {
        Logger.debug(`[${jobId}] Headers: ${JSON.stringify(req.headers)}`);
        
        const quote = await generateQuote();
        Logger.info(`[${jobId}] Quote generated: ${quote.substring(0, 80)}...`);
        
        const result = await addQuoteToKeep(quote);
        Logger.info(`[${jobId}] Successfully added to Google Keep`);
        
        res.json({
            success: true,
            jobId: jobId,
            message: 'Scheduled quote added successfully',
            quote: quote,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        Logger.error(`[${jobId}] Scheduled job failed:`, error);
        
        res.status(500).json({
            success: false,
            jobId: jobId,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * Main endpoint with documentation
 */
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Google Keep Quote Bot 🤖</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { 
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                    margin: 0; 
                    padding: 20px; 
                    background: #f5f5f5;
                    color: #333;
                }
                .container { 
                    max-width: 800px; 
                    margin: 0 auto; 
                    background: white;
                    padding: 30px;
                    border-radius: 10px;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                }
                h1 { color: #4285f4; margin-top: 0; }
                .status { 
                    padding: 10px 15px; 
                    background: #e8f5e9; 
                    border-left: 4px solid #4caf50;
                    margin: 20px 0;
                }
                .endpoint { 
                    background: #f8f9fa; 
                    padding: 15px; 
                    margin: 15px 0; 
                    border-radius: 5px;
                    border-left: 4px solid #4285f4;
                }
                .button { 
                    display: inline-block; 
                    padding: 12px 24px; 
                    background: #4285f4; 
                    color: white; 
                    text-decoration: none;
                    border-radius: 5px;
                    margin: 10px 10px 10px 0;
                    font-weight: 500;
                    transition: background 0.3s;
                }
                .button:hover { background: #3367d6; }
                .button.secondary { background: #5f6368; }
                .button.secondary:hover { background: #3c4043; }
                code { 
                    background: #f1f3f4; 
                    padding: 2px 6px; 
                    border-radius: 3px; 
                    font-family: 'Courier New', monospace;
                }
                .instructions { background: #fff8e1; padding: 15px; border-radius: 5px; margin: 20px 0; }
                .log { background: #263238; color: #fff; padding: 15px; border-radius: 5px; font-family: monospace; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🤖 Google Keep Quote Bot</h1>
                <p>Automatically add AI-generated quotes to Google Keep</p>
                
                <div class="status">
                    <strong>Status:</strong> Service is running on port ${port}
                </div>
                
                <h2>📡 API Endpoints</h2>
                <div class="endpoint">
                    <strong>GET <code>/health</code></strong> - Health check and system status
                </div>
                <div class="endpoint">
                    <strong>GET <code>/debug</code></strong> - Detailed debugging information
                </div>
                <div class="endpoint">
                    <strong>GET <code>/add-quote</code></strong> - Manually trigger quote creation
                </div>
                <div class="endpoint">
                    <strong>POST <code>/scheduled-quote</code></strong> - For scheduled jobs (Cloud Scheduler)
                </div>
                
                <h2>⚡ Quick Actions</h2>
                <a href="/health" class="button">Check Health</a>
                <a href="/debug" class="button">Debug Info</a>
                <a href="/add-quote" class="button">Add Quote Now</a>
                
                <h2>🔧 Setup Instructions</h2>
                <div class="instructions">
                    <ol>
                        <li>Export your Chrome profile to Google Cloud Storage as <code>profile.zip</code></li>
                        <li>Set environment variables: <code>GEMINI_API_KEY</code>, <code>BUCKET_NAME</code></li>
                        <li>Schedule <code>/scheduled-quote</code> endpoint to run daily via Cloud Scheduler</li>
                        <li>Monitor logs at <code>/tmp/quote-bot.log</code></li>
                    </ol>
                </div>
                
                <h2>📝 Sample Commands</h2>
                <div class="log">
                    # Test manually<br>
                    curl -X POST https://${req.headers.host}/scheduled-quote<br><br>
                    # Check health<br>
                    curl https://${req.headers.host}/health<br><br>
                    # Get debug info<br>
                    curl https://${req.headers.host}/debug | jq .
                </div>
                
                <p style="margin-top: 30px; color: #666; font-size: 0.9em;">
                    Version 2.0.0 | Built with Express.js & Playwright
                </p>
            </div>
        </body>
        </html>
    `);
});

// Error handling middleware
app.use((err, req, res, next) => {
    Logger.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        timestamp: new Date().toISOString()
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        timestamp: new Date().toISOString()
    });
});

// Start server
app.listen(port, () => {
    Logger.info(`🚀 Server running on port ${port}`);
    Logger.info(`📝 Health check: http://localhost:${port}/health`);
    Logger.info(`🐛 Debug info: http://localhost:${port}/debug`);
    Logger.info(`✏️  Manual trigger: http://localhost:${port}/add-quote`);
});

module.exports = app;
