const express = require('express');
const { Storage } = require('@google-cloud/storage');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');

const app = express();
const port = process.env.PORT || 8080;

// Initialize storage only if credentials are available
let storage;
try {
    storage = new Storage();
} catch (error) {
    console.warn('Google Cloud Storage initialization warning:', error.message);
    storage = null;
}

// Initialize Gemini AI
let genAI = null;
let GoogleGenerativeAI = null;
if (process.env.GEMINI_API_KEY) {
    try {
        GoogleGenerativeAI = require("@google/generative-ai");
        genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    } catch (error) {
        console.error('Failed to initialize Gemini AI:', error.message);
    }
}

// Configuration
const CONFIG = {
    BUCKET_NAME: process.env.BUCKET_NAME || 'keep-profile-store',
    MAX_RETRIES: 3,
    BROWSER_TIMEOUT: 60000, // 60 seconds
    NAVIGATION_TIMEOUT: 45000 // 45 seconds
};

// Enhanced logging
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}`;
    console.log(logMessage);
    
    // Also write to file for debugging
    try {
        fs.appendFileSync('/tmp/app.log', logMessage + '\n');
    } catch (e) {
        // Ignore file write errors
    }
}

// Error handler middleware
app.use((err, req, res, next) => {
    log(`Unhandled error: ${err.message}`, 'ERROR');
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        timestamp: new Date().toISOString()
    });
});

// Body parser middleware
app.use(express.json());

// ==================== HEALTH & TEST ENDPOINTS ====================

app.get('/health', (req, res) => {
    const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'Google Keep Quote Bot',
        version: '2.0.0',
        environment: {
            NODE_ENV: process.env.NODE_ENV,
            PORT: port,
            BUCKET_NAME: CONFIG.BUCKET_NAME,
            HAS_GEMINI_KEY: !!process.env.GEMINI_API_KEY,
            HAS_STORAGE: !!storage
        }
    };
    
    log('Health check requested');
    res.json(health);
});

app.get('/test', async (req, res) => {
    log('Comprehensive test requested');
    
    const results = {
        timestamp: new Date().toISOString(),
        system: {
            node: process.version,
            platform: process.platform,
            uptime: process.uptime(),
            memory: process.memoryUsage()
        },
        environment: {
            BUCKET_NAME: CONFIG.BUCKET_NAME,
            HAS_GEMINI: !!genAI
        },
        tests: {}
    };
    
    // Test 1: File system
    try {
        const testFile = '/tmp/test-write.txt';
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
        results.tests.filesystem = { success: true };
    } catch (error) {
        results.tests.filesystem = { success: false, error: error.message };
    }
    
    // Test 2: Storage
    if (storage) {
        try {
            const [buckets] = await storage.getBuckets();
            const bucket = storage.bucket(CONFIG.BUCKET_NAME);
            const [exists] = await bucket.exists();
            results.tests.storage = {
                success: true,
                buckets: buckets.length,
                targetBucketExists: exists
            };
        } catch (error) {
            results.tests.storage = { success: false, error: error.message };
        }
    }
    
    // Test 3: Playwright
    let browser = null;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage']
        });
        
        const page = await browser.newPage();
        await page.goto('https://httpbin.org/ip', { timeout: 15000 });
        const content = await page.content();
        
        results.tests.playwright = {
            success: true,
            message: 'Browser launched successfully',
            canNavigate: content.includes('httpbin.org')
        };
        
        await browser.close();
    } catch (error) {
        results.tests.playwright = { success: false, error: error.message };
        if (browser) await browser.close();
    }
    
    // Test 4: Gemini
    if (genAI) {
        try {
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const result = await model.generateContent("Say 'TEST OK'");
            const text = result.response.text();
            results.tests.gemini = {
                success: true,
                message: text.trim()
            };
        } catch (error) {
            results.tests.gemini = { success: false, error: error.message };
        }
    }
    
    res.json({ success: true, results });
});

// ==================== QUOTE GENERATION ====================

async function generateQuote() {
    if (!genAI) {
        const fallbackQuotes = [
            "The journey of a thousand miles begins with one step. - Lao Tzu",
            "Do what you can, with what you have, where you are. - Theodore Roosevelt",
            "Life is what happens to you while you're busy making other plans. - John Lennon"
        ];
        return fallbackQuotes[Math.floor(Math.random() * fallbackQuotes.length)];
    }
    
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `Generate a short, inspirational quote for today (${new Date().toLocaleDateString()}). Keep it under 100 characters.`;
        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (error) {
        log(`Quote generation failed: ${error.message}`, 'WARN');
        return "Every day is a new beginning. - Daily Wisdom";
    }
}

// ==================== GOOGLE KEEP AUTOMATION ====================

async function addQuoteToKeep(quote) {
    log('Starting Google Keep automation');
    
    let browser = null;
    let profileDir = '/tmp/profile-' + Date.now();
    let zipPath = '/tmp/profile-' + Date.now() + '.zip';
    
    try {
        // Step 1: Download profile from GCS
        if (!storage) {
            throw new Error('Google Cloud Storage not initialized');
        }
        
        log(`Downloading profile from bucket: ${CONFIG.BUCKET_NAME}`);
        const bucket = storage.bucket(CONFIG.BUCKET_NAME);
        
        try {
            await bucket.file('profile.zip').download({ destination: zipPath });
        } catch (downloadError) {
            throw new Error(`Failed to download profile.zip: ${downloadError.message}`);
        }
        
        if (!fs.existsSync(zipPath)) {
            throw new Error('Profile download failed - file not found');
        }
        
        // Step 2: Extract profile
        log('Extracting profile...');
        fs.mkdirSync(profileDir, { recursive: true });
        
        await new Promise((resolve, reject) => {
            fs.createReadStream(zipPath)
                .pipe(unzipper.Extract({ path: profileDir }))
                .on('close', resolve)
                .on('error', (err) => {
                    reject(new Error(`Extraction failed: ${err.message}`));
                });
        });
        
        // Step 3: Launch browser with profile
        log('Launching browser...');
        browser = await chromium.launchPersistentContext(profileDir, {
            headless: true,
            viewport: { width: 1280, height: 800 },
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=site-per-process'
            ],
            ignoreHTTPSErrors: true,
            timeout: CONFIG.BROWSER_TIMEOUT
        });
        
        const page = await browser.newPage();
        
        // Set user agent to avoid detection
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Step 4: Navigate to Google Keep with better error handling
        log('Navigating to Google Keep...');
        
        try {
            await page.goto('https://keep.google.com', {
                waitUntil: 'domcontentloaded',
                timeout: CONFIG.NAVIGATION_TIMEOUT
            });
        } catch (navigationError) {
            // Try alternative approach
            log(`First navigation failed: ${navigationError.message}`, 'WARN');
            log('Trying alternative navigation method...');
            
            await page.goto('https://keep.google.com', {
                waitUntil: 'load',
                timeout: CONFIG.NAVIGATION_TIMEOUT
            });
        }
        
        // Wait for page to stabilize
        await page.waitForTimeout(5000);
        
        // Take screenshot for debugging
        const screenshotPath = `/tmp/keep-${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: false });
        log(`Screenshot saved: ${screenshotPath}`);
        
        // Step 5: Check if we're on Google Keep
        const pageTitle = await page.title();
        const currentUrl = page.url();
        log(`Page title: "${pageTitle}", URL: ${currentUrl}`);
        
        if (!currentUrl.includes('keep.google.com')) {
            throw new Error(`Not on Google Keep. Current URL: ${currentUrl}`);
        }
        
        // Step 6: Try to find and click the note input
        log('Looking for note input...');
        
        // Try multiple selectors for the note input
        const selectors = [
            'div[aria-label="Take a note"]',
            'div[role="button"][aria-label*="Take"]',
            'textarea[aria-label="Note"]',
            'div[contenteditable="true"]',
            'div[role="textbox"]'
        ];
        
        let noteInput = null;
        for (const selector of selectors) {
            try {
                const element = await page.$(selector);
                if (element) {
                    noteInput = element;
                    log(`Found note input with selector: ${selector}`);
                    break;
                }
            } catch (e) {
                // Continue to next selector
            }
        }
        
        if (!noteInput) {
            // Fallback: look for any clickable element that might be the note button
            const buttons = await page.$$('button, div[role="button"], [aria-label*="note"], [aria-label*="Note"]');
            if (buttons.length > 0) {
                noteInput = buttons[0];
                log('Found potential note button by fallback');
            }
        }
        
        if (noteInput) {
            await noteInput.click();
            await page.waitForTimeout(1000);
            
            // Type the quote
            log(`Typing quote: ${quote.substring(0, 50)}...`);
            await page.keyboard.type(quote);
            await page.waitForTimeout(2000);
            
            // Press Escape to save
            await page.keyboard.press('Escape');
            await page.waitForTimeout(3000);
            
            log('Note creation completed');
        } else {
            log('Could not find note input. Trying keyboard shortcut...');
            await page.keyboard.press('c'); // Google Keep shortcut for new note
            await page.waitForTimeout(1000);
            await page.keyboard.type(quote);
            await page.waitForTimeout(2000);
            await page.keyboard.press('Escape');
        }
        
        // Take final screenshot
        const finalScreenshot = `/tmp/keep-final-${Date.now()}.png`;
        await page.screenshot({ path: finalScreenshot });
        log(`Final screenshot: ${finalScreenshot}`);
        
        // Step 7: Verify success
        await page.waitForTimeout(2000);
        
        log('Google Keep automation completed successfully');
        return { success: true, quote };
        
    } catch (error) {
        log(`Google Keep automation failed: ${error.message}`, 'ERROR');
        log(`Stack: ${error.stack}`, 'ERROR');
        
        // Take error screenshot if possible
        if (browser) {
            try {
                const pages = await browser.pages();
                if (pages.length > 0) {
                    const errorScreenshot = `/tmp/keep-error-${Date.now()}.png`;
                    await pages[0].screenshot({ path: errorScreenshot, fullPage: true });
                    log(`Error screenshot saved: ${errorScreenshot}`);
                }
            } catch (screenshotError) {
                log(`Failed to take error screenshot: ${screenshotError.message}`, 'WARN');
            }
        }
        
        throw error;
        
    } finally {
        // Cleanup browser
        if (browser) {
            try {
                await browser.close();
                log('Browser closed');
            } catch (closeError) {
                log(`Error closing browser: ${closeError.message}`, 'WARN');
            }
        }
        
        // Cleanup files
        try {
            if (fs.existsSync(profileDir)) {
                fs.rmSync(profileDir, { recursive: true, force: true });
            }
            if (fs.existsSync(zipPath)) {
                fs.unlinkSync(zipPath);
            }
        } catch (cleanupError) {
            log(`Cleanup error: ${cleanupError.message}`, 'WARN');
        }
    }
}

// ==================== API ENDPOINTS ====================

// FIX: Add POST handler for root endpoint (Cloud Scheduler is hitting this)
app.post('/', async (req, res) => {
    log('Cloud Scheduler hit root endpoint');
    log(`Request body: ${JSON.stringify(req.body)}`);
    log(`Request headers: ${JSON.stringify(req.headers)}`);
    
    // Redirect to the correct endpoint
    res.redirect(307, '/scheduled-quote');
});

// Manual trigger
app.get('/add-quote', async (req, res) => {
    log('Manual quote request received');
    
    try {
        const quote = await generateQuote();
        log(`Generated quote: ${quote}`);
        
        const result = await addQuoteToKeep(quote);
        
        res.json({
            success: true,
            message: 'Quote added to Google Keep',
            quote: quote,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        log(`Manual request failed: ${error.message}`, 'ERROR');
        
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Cloud Scheduler endpoint
app.post('/scheduled-quote', async (req, res) => {
    const jobId = 'job-' + Date.now();
    log(`[${jobId}] Cloud Scheduler job started`);
    
    try {
        // Generate quote
        log(`[${jobId}] Generating quote...`);
        const quote = await generateQuote();
        log(`[${jobId}] Quote: ${quote.substring(0, 100)}...`);
        
        // Add to Google Keep
        log(`[${jobId}] Adding to Google Keep...`);
        const result = await addQuoteToKeep(quote);
        
        log(`[${jobId}] Job completed successfully`);
        
        res.json({
            success: true,
            jobId: jobId,
            message: 'Daily quote added to Google Keep',
            quote: quote,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        log(`[${jobId}] Job failed: ${error.message}`, 'ERROR');
        
        res.status(500).json({
            success: false,
            jobId: jobId,
            error: error.message,
            timestamp: new Date().toISOString(),
            suggestion: 'Check if Chrome profile is properly authenticated in Google Keep'
        });
    }
});

// Alternative endpoint name for Cloud Scheduler
app.post('/daily-quote', async (req, res) => {
    log('Alternative endpoint /daily-quote called');
    // Just redirect to scheduled-quote
    const reqClone = Object.assign({}, req);
    reqClone.url = '/scheduled-quote';
    app.handle(reqClone, res);
});

// Root GET endpoint
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Google Keep Quote Bot</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; }
                .endpoint { background: #f5f5f5; padding: 15px; margin: 10px 0; border-radius: 5px; }
                code { background: #e0e0e0; padding: 2px 5px; border-radius: 3px; }
                .button { 
                    display: inline-block; 
                    padding: 10px 20px; 
                    background: #4285f4; 
                    color: white; 
                    text-decoration: none; 
                    border-radius: 4px; 
                    margin: 5px;
                }
            </style>
        </head>
        <body>
            <h1>Google Keep Quote Bot 🤖</h1>
            
            <h2>Endpoints:</h2>
            <div class="endpoint">
                <strong>GET <code>/health</code></strong> - Health check
            </div>
            <div class="endpoint">
                <strong>GET <code>/test</code></strong> - Comprehensive system test
            </div>
            <div class="endpoint">
                <strong>GET <code>/add-quote</code></strong> - Manually add a quote
            </div>
            <div class="endpoint">
                <strong>POST <code>/scheduled-quote</code></strong> - For Cloud Scheduler
            </div>
            <div class="endpoint">
                <strong>POST <code>/daily-quote</code></strong> - Alternative scheduler endpoint
            </div>
            
            <h2>Quick Actions:</h2>
            <a href="/health" class="button">Health Check</a>
            <a href="/test" class="button">Run Tests</a>
            <a href="/add-quote" class="button">Add Quote Now</a>
            
            <h2>Cloud Scheduler Setup:</h2>
            <p>Use one of these URLs:</p>
            <ul>
                <li><code>POST https://your-service.run.app/scheduled-quote</code></li>
                <li><code>POST https://your-service.run.app/daily-quote</code></li>
            </ul>
        </body>
        </html>
    `);
});

// Start server
const server = app.listen(port, () => {
    log(`🚀 Server running on port ${port}`);
    log(`📡 Health endpoint: http://localhost:${port}/health`);
    log(`🧪 Test endpoint: http://localhost:${port}/test`);
    log(`⏰ Cloud Scheduler endpoints:`);
    log(`   POST http://localhost:${port}/scheduled-quote`);
    log(`   POST http://localhost:${port}/daily-quote`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    log('Received SIGTERM, shutting down gracefully...');
    server.close(() => {
        log('Server closed');
        process.exit(0);
    });
});

module.exports = app;
