const express = require('express');
const { Storage } = require('@google-cloud/storage');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');

const app = express();
const port = process.env.PORT || 8080;

// Initialize Google Cloud Storage
let storage;
try {
    storage = new Storage();
    console.log('✅ Google Cloud Storage initialized');
} catch (error) {
    console.error('❌ Google Cloud Storage initialization failed:', error.message);
    storage = null;
}

// Initialize Gemini AI
let genAI = null;
if (process.env.GEMINI_API_KEY) {
    try {
        const { GoogleGenerativeAI } = require("@google/generative-ai");
        genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        console.log('✅ Gemini AI initialized');
    } catch (error) {
        console.error('❌ Gemini AI initialization failed:', error.message);
    }
}

// Configuration
const CONFIG = {
    BUCKET_NAME: process.env.BUCKET_NAME || 'keep-profile-store',
    CHROME_PATH: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable'
};

// Enhanced logging
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}`;
    console.log(logMessage);
    
    // Write to file for debugging
    try {
        fs.appendFileSync('/tmp/app.log', logMessage + '\n');
    } catch (e) {
        // Ignore file write errors
    }
}

// Test Chrome installation
async function testChromeInstallation() {
    log('Testing Chrome installation...');
    
    try {
        // Check if Chrome binary exists
        if (fs.existsSync(CONFIG.CHROME_PATH)) {
            log(`✅ Chrome found at: ${CONFIG.CHROME_PATH}`);
        } else {
            // Search for Chrome in common locations
            const chromePaths = [
                '/usr/bin/google-chrome-stable',
                '/usr/bin/google-chrome',
                '/usr/bin/chromium',
                '/usr/bin/chromium-browser'
            ];
            
            for (const path of chromePaths) {
                if (fs.existsSync(path)) {
                    log(`✅ Found Chrome at: ${path}`);
                    CONFIG.CHROME_PATH = path;
                    break;
                }
            }
            
            if (!CONFIG.CHROME_PATH) {
                throw new Error('Chrome not found in any common location');
            }
        }
        
        // Try to get Chrome version
        const { execSync } = require('child_process');
        const version = execSync(`${CONFIG.CHROME_PATH} --version`).toString().trim();
        log(`✅ Chrome version: ${version}`);
        
        return { success: true, path: CONFIG.CHROME_PATH, version };
        
    } catch (error) {
        log(`❌ Chrome test failed: ${error.message}`, 'ERROR');
        return { success: false, error: error.message };
    }
}

// Test Playwright with Chrome
async function testPlaywright() {
    log('Testing Playwright with Chrome...');
    
    let browser = null;
    try {
        log('Launching browser with custom Chrome executable...');
        
        browser = await chromium.launch({
            executablePath: CONFIG.CHROME_PATH,
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-sync',
                '--disable-translate',
                '--metrics-recording-only',
                '--mute-audio',
                '--no-first-run',
                '--safebrowsing-disable-auto-update',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor',
                '--disable-breakpad'
            ],
            timeout: 30000
        });
        
        log('✅ Browser launched successfully');
        
        const page = await browser.newPage();
        await page.goto('https://httpbin.org/ip', { timeout: 15000 });
        const content = await page.content();
        
        log('✅ Navigation successful');
        
        await browser.close();
        return { success: true };
        
    } catch (error) {
        log(`❌ Playwright test failed: ${error.message}`, 'ERROR');
        if (browser) {
            try {
                await browser.close();
            } catch (e) {
                log('Error closing browser:', e.message);
            }
        }
        return { success: false, error: error.message };
    }
}

// ==================== HEALTH ENDPOINTS ====================

app.get('/health', async (req, res) => {
    log('Health check requested');
    
    const health = {
        status: 'checking',
        timestamp: new Date().toISOString(),
        service: 'Google Keep Quote Bot',
        tests: {}
    };
    
    // Test Chrome installation
    health.tests.chrome = await testChromeInstallation();
    
    // Test Playwright
    health.tests.playwright = await testPlaywright();
    
    // Test Storage
    if (storage) {
        try {
            const [buckets] = await storage.getBuckets();
            health.tests.storage = { 
                success: true, 
                bucketCount: buckets.length,
                hasTargetBucket: buckets.some(b => b.name === CONFIG.BUCKET_NAME)
            };
        } catch (error) {
            health.tests.storage = { success: false, error: error.message };
        }
    }
    
    // Test Gemini
    if (genAI) {
        try {
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const result = await model.generateContent("Say 'OK'");
            health.tests.gemini = { 
                success: true, 
                response: result.response.text().trim() 
            };
        } catch (error) {
            health.tests.gemini = { success: false, error: error.message };
        }
    }
    
    // Determine overall status
    const allTests = Object.values(health.tests);
    const failedTests = allTests.filter(test => !test.success);
    health.status = failedTests.length === 0 ? 'healthy' : 'unhealthy';
    health.failedTests = failedTests.length;
    
    res.json(health);
});

// ==================== QUOTE GENERATION ====================

async function generateQuote() {
    if (!genAI) {
        log('Gemini AI not available, using fallback quote', 'WARN');
        const fallbackQuotes = [
            "The best time to plant a tree was 20 years ago. The second best time is now. - Chinese Proverb",
            "Your time is limited, don't waste it living someone else's life. - Steve Jobs",
            "The journey of a thousand miles begins with one step. - Lao Tzu"
        ];
        return fallbackQuotes[Math.floor(Math.random() * fallbackQuotes.length)];
    }
    
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const today = new Date().toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
        
        const prompt = `Generate a short, inspirational quote for ${today}. 
        Make it unique, thoughtful, and under 150 characters. 
        Format: "Quote text" - Author/Theme`;
        
        const result = await model.generateContent(prompt);
        const quote = result.response.text().trim();
        
        log(`✅ Generated quote: ${quote.substring(0, 100)}...`);
        return quote;
        
    } catch (error) {
        log(`❌ Quote generation failed: ${error.message}`, 'ERROR');
        return "Every day is a new beginning. Take a deep breath and start again. - Daily Wisdom";
    }
}

// ==================== GOOGLE KEEP AUTOMATION ====================

async function addQuoteToKeep(quote) {
    log('🚀 Starting Google Keep automation...');
    
    let browser = null;
    const profileDir = `/tmp/chrome-profile-${Date.now()}`;
    const zipPath = `/tmp/profile-${Date.now()}.zip`;
    
    try {
        // Step 1: Check storage
        if (!storage) {
            throw new Error('Google Cloud Storage not available');
        }
        
        // Step 2: Download Chrome profile
        log(`📥 Downloading profile from: ${CONFIG.BUCKET_NAME}`);
        
        try {
            await storage.bucket(CONFIG.BUCKET_NAME)
                .file('profile.zip')
                .download({ destination: zipPath });
        } catch (downloadError) {
            log(`❌ Profile download failed: ${downloadError.message}`, 'ERROR');
            throw new Error(`Cannot download Chrome profile: ${downloadError.message}`);
        }
        
        if (!fs.existsSync(zipPath)) {
            throw new Error('Profile download failed - file not created');
        }
        
        log(`✅ Profile downloaded: ${fs.statSync(zipPath).size} bytes`);
        
        // Step 3: Extract profile
        log('📦 Extracting profile...');
        
        // Clean up old directory if exists
        if (fs.existsSync(profileDir)) {
            fs.rmSync(profileDir, { recursive: true, force: true });
        }
        
        fs.mkdirSync(profileDir, { recursive: true });
        
        await new Promise((resolve, reject) => {
            fs.createReadStream(zipPath)
                .pipe(unzipper.Extract({ path: profileDir }))
                .on('close', resolve)
                .on('error', reject);
        });
        
        log(`✅ Profile extracted to: ${profileDir}`);
        
        // Step 4: Launch browser with profile
        log('🌐 Launching Chrome with profile...');
        
        browser = await chromium.launchPersistentContext(profileDir, {
            executablePath: CONFIG.CHROME_PATH,
            headless: true,
            viewport: { width: 1280, height: 800 },
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-sync',
                '--disable-translate',
                '--metrics-recording-only',
                '--mute-audio',
                '--no-first-run',
                '--safebrowsing-disable-auto-update',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor',
                '--disable-breakpad',
                '--disable-component-update',
                '--disable-default-apps',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--window-size=1280,800'
            ],
            ignoreDefaultArgs: [
                '--disable-component-extensions-with-background-pages',
                '--disable-background-networking'
            ],
            timeout: 60000
        });
        
        log('✅ Browser launched successfully');
        
        const page = await browser.newPage();
        
        // Set a realistic user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Step 5: Navigate to Google Keep
        log('🧭 Navigating to Google Keep...');
        
        try {
            await page.goto('https://keep.google.com', {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
            
            // Wait for page to stabilize
            await page.waitForTimeout(5000);
            
            log(`✅ Loaded page: ${await page.title()}`);
            
        } catch (navError) {
            log(`⚠️  Navigation warning: ${navError.message}`, 'WARN');
            
            // Try alternative navigation method
            await page.goto('https://keep.google.com', {
                waitUntil: 'load',
                timeout: 30000
            });
            
            await page.waitForTimeout(5000);
        }
        
        // Take screenshot for debugging
        const screenshotPath = `/tmp/keep-${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath });
        log(`📸 Screenshot saved: ${screenshotPath}`);
        
        // Step 6: Check if logged in
        log('🔐 Checking login status...');
        
        const isLoggedIn = await page.evaluate(() => {
            // Check for various Google Keep UI elements
            const selectors = [
                'div[aria-label="Take a note"]',
                'div[role="button"][aria-label*="Take"]',
                'textarea[aria-label="Note"]',
                'div[contenteditable="true"]',
                'div[aria-label="Take a note..."]'
            ];
            
            for (const selector of selectors) {
                if (document.querySelector(selector)) {
                    return true;
                }
            }
            
            // Check for Google account indicator
            if (document.querySelector('img[alt*="Account"]') || 
                document.querySelector('[aria-label*="Google Account"]')) {
                return true;
            }
            
            return false;
        });
        
        if (!isLoggedIn) {
            const loginScreenshot = `/tmp/keep-not-logged-${Date.now()}.png`;
            await page.screenshot({ path: loginScreenshot, fullPage: true });
            log(`❌ Not logged in. Screenshot: ${loginScreenshot}`);
            throw new Error('Not logged into Google Keep. Please check your Chrome profile authentication.');
        }
        
        log('✅ Successfully logged in');
        
        // Step 7: Create new note
        log('📝 Creating new note...');
        
        // Try multiple ways to create a note
        const noteSelectors = [
            'div[aria-label="Take a note"]',
            'div[role="button"][aria-label*="Take"]',
            'div[aria-label="Take a note..."]'
        ];
        
        let noteCreated = false;
        for (const selector of noteSelectors) {
            try {
                const noteButton = await page.$(selector);
                if (noteButton) {
                    await noteButton.click();
                    await page.waitForTimeout(1000);
                    noteCreated = true;
                    log(`✅ Clicked note button: ${selector}`);
                    break;
                }
            } catch (e) {
                // Try next selector
                continue;
            }
        }
        
        if (!noteCreated) {
            // Fallback: Use keyboard shortcut 'c' for new note
            log('Using keyboard shortcut (c) for new note...');
            await page.keyboard.press('c');
            await page.waitForTimeout(1000);
        }
        
        // Step 8: Type the quote
        log(`✍️  Typing quote: ${quote.substring(0, 80)}...`);
        await page.keyboard.type(quote);
        await page.waitForTimeout(2000);
        
        // Step 9: Save note (Escape key)
        await page.keyboard.press('Escape');
        await page.waitForTimeout(3000);
        
        log('✅ Note saved successfully!');
        
        // Step 10: Take final screenshot
        const finalScreenshot = `/tmp/keep-success-${Date.now()}.png`;
        await page.screenshot({ path: finalScreenshot });
        log(`📸 Final screenshot: ${finalScreenshot}`);
        
        log('🎉 Google Keep automation completed successfully!');
        
        return {
            success: true,
            quote: quote,
            screenshots: [screenshotPath, finalScreenshot]
        };
        
    } catch (error) {
        log(`❌ Google Keep automation failed: ${error.message}`, 'ERROR');
        
        // Take error screenshot if possible
        if (browser) {
            try {
                const pages = await browser.pages();
                if (pages.length > 0) {
                    const errorScreenshot = `/tmp/keep-error-${Date.now()}.png`;
                    await pages[0].screenshot({ 
                        path: errorScreenshot, 
                        fullPage: true 
                    });
                    log(`📸 Error screenshot: ${errorScreenshot}`);
                }
            } catch (screenshotError) {
                log(`Cannot take error screenshot: ${screenshotError.message}`, 'WARN');
            }
        }
        
        throw error;
        
    } finally {
        // Cleanup browser
        if (browser) {
            try {
                await browser.close();
                log('✅ Browser closed');
            } catch (closeError) {
                log(`⚠️  Error closing browser: ${closeError.message}`, 'WARN');
            }
        }
        
        // Cleanup files
        try {
            if (fs.existsSync(profileDir)) {
                fs.rmSync(profileDir, { recursive: true, force: true });
                log('✅ Profile directory cleaned');
            }
            if (fs.existsSync(zipPath)) {
                fs.unlinkSync(zipPath);
                log('✅ Zip file cleaned');
            }
        } catch (cleanupError) {
            log(`⚠️  Cleanup error: ${cleanupError.message}`, 'WARN');
        }
    }
}

// ==================== API ENDPOINTS ====================

app.use(express.json());

// Root endpoint (for Cloud Scheduler)
app.post('/', async (req, res) => {
    const jobId = `job-${Date.now()}`;
    log(`[${jobId}] Cloud Scheduler job started`);
    
    try {
        const quote = await generateQuote();
        const result = await addQuoteToKeep(quote);
        
        log(`[${jobId}] ✅ Job completed successfully`);
        
        res.json({
            success: true,
            jobId: jobId,
            message: 'Daily quote added to Google Keep',
            quote: quote,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        log(`[${jobId}] ❌ Job failed: ${error.message}`, 'ERROR');
        
        res.status(500).json({
            success: false,
            jobId: jobId,
            error: error.message,
            timestamp: new Date().toISOString(),
            suggestion: 'Check if Chrome profile is properly authenticated in Google Keep'
        });
    }
});

// Alternative endpoint
app.post('/scheduled-quote', async (req, res) => {
    log('Alternative endpoint /scheduled-quote called');
    res.redirect(307, '/');
});

// Manual trigger
app.get('/add-quote', async (req, res) => {
    const jobId = `manual-${Date.now()}`;
    log(`[${jobId}] Manual trigger requested`);
    
    try {
        const quote = await generateQuote();
        const result = await addQuoteToKeep(quote);
        
        res.json({
            success: true,
            jobId: jobId,
            message: 'Manual quote added to Google Keep',
            quote: quote,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        log(`[${jobId}] Manual trigger failed: ${error.message}`, 'ERROR');
        
        res.status(500).json({
            success: false,
            jobId: jobId,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Home page
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Google Keep Quote Bot</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; }
                h1 { color: #4285f4; }
                .status { padding: 15px; margin: 20px 0; border-radius: 5px; }
                .healthy { background: #e8f5e9; border-left: 4px solid #4caf50; }
                .unhealthy { background: #ffebee; border-left: 4px solid #f44336; }
                .button { 
                    padding: 12px 24px; 
                    background: #4285f4; 
                    color: white; 
                    text-decoration: none; 
                    border-radius: 4px; 
                    margin: 5px;
                    display: inline-block;
                }
                .button:hover { background: #3367d6; }
                .endpoint { background: #f5f5f5; padding: 15px; margin: 10px 0; border-radius: 5px; }
                pre { background: #263238; color: white; padding: 15px; border-radius: 5px; overflow: auto; }
            </style>
        </head>
        <body>
            <h1>🤖 Google Keep Quote Bot</h1>
            <p>Automatically add AI-generated quotes to Google Keep</p>
            
            <div id="status" class="status">
                <p>Checking system status...</p>
            </div>
            
            <h2>🚀 Quick Actions</h2>
            <a href="/health" class="button" target="_blank">Health Check</a>
            <a href="/add-quote" class="button">Add Quote Now</a>
            <button onclick="runTest()" class="button">Test Automation</button>
            
            <h2>📡 API Endpoints</h2>
            <div class="endpoint">
                <strong>GET <code>/health</code></strong> - Comprehensive system health check
            </div>
            <div class="endpoint">
                <strong>GET <code>/add-quote</code></strong> - Manually add a quote
            </div>
            <div class="endpoint">
                <strong>POST <code>/</code></strong> - Cloud Scheduler endpoint
            </div>
            
            <div id="result" style="margin-top: 30px;"></div>
            
            <script>
                // Check system status on load
                async function checkStatus() {
                    const statusDiv = document.getElementById('status');
                    try {
                        const response = await fetch('/health');
                        const data = await response.json();
                        
                        statusDiv.className = data.status === 'healthy' ? 'status healthy' : 'status unhealthy';
                        statusDiv.innerHTML = `
                            <h3>System Status: ${data.status === 'healthy' ? '✅ Healthy' : '❌ Issues Found'}</h3>
                            <p>Timestamp: ${data.timestamp}</p>
                            <details>
                                <summary>View Details</summary>
                                <pre>${JSON.stringify(data, null, 2)}</pre>
                            </details>
                        `;
                    } catch (error) {
                        statusDiv.className = 'status unhealthy';
                        statusDiv.innerHTML = `<p>❌ Cannot reach service: ${error.message}</p>`;
                    }
                }
                
                // Run automation test
                async function runTest() {
                    const resultDiv = document.getElementById('result');
                    resultDiv.innerHTML = '<p>Running automation test... This may take 30-60 seconds ⏳</p>';
                    
                    try {
                        const response = await fetch('/add-quote');
                        const data = await response.json();
                        
                        if (data.success) {
                            resultDiv.innerHTML = `
                                <div style="background: #e8f5e9; padding: 15px; border-radius: 5px;">
                                    <h3>✅ Success!</h3>
                                    <p><strong>Quote:</strong> ${data.quote}</p>
                                    <p><strong>Time:</strong> ${data.timestamp}</p>
                                    <p><strong>Job ID:</strong> ${data.jobId}</p>
                                </div>
                            `;
                        } else {
                            resultDiv.innerHTML = `
                                <div style="background: #ffebee; padding: 15px; border-radius: 5px;">
                                    <h3>❌ Failed</h3>
                                    <p><strong>Error:</strong> ${data.error}</p>
                                    <pre>${JSON.stringify(data, null, 2)}</pre>
                                </div>
                            `;
                        }
                    } catch (error) {
                        resultDiv.innerHTML = `<p>❌ Request failed: ${error.message}</p>`;
                    }
                }
                
                // Check status on page load
                checkStatus();
            </script>
        </body>
        </html>
    `);
});

// Start server
app.listen(port, () => {
    log(`🚀 Server started on port ${port}`);
    log(`🌐 Open http://localhost:${port} in browser`);
    log(`🏥 Health endpoint: http://localhost:${port}/health`);
    log(`⏰ Cloud Scheduler: POST to http://localhost:${port}/`);
});

module.exports = app;
