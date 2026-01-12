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
    MAX_RETRIES: 3
};

// Logging utility
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}`;
    console.log(logMessage);
}

// Simple quote generator (for testing)
async function generateQuote() {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = "Generate a short inspirational quote about technology.";
        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (error) {
        log(`Quote generation failed: ${error.message}`, 'ERROR');
        return "Technology is best when it brings people together. - Tech Wisdom";
    }
}

// Test Playwright installation
async function testPlaywright() {
    let browser = null;
    try {
        log('Testing Playwright installation...');
        
        // Check if Chrome is available
        const chromePath = process.env.CHROME_BIN || '/usr/bin/google-chrome-stable';
        if (fs.existsSync(chromePath)) {
            log(`Chrome found at: ${chromePath}`);
        } else {
            log('Chrome not found at default path', 'WARN');
        }
        
        // Try to launch browser
        log('Attempting to launch browser...');
        browser = await chromium.launch({ 
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage']
        });
        
        const page = await browser.newPage();
        log('Browser launched successfully!');
        
        // Test navigation
        log('Testing navigation to example.com...');
        await page.goto('https://example.com', { timeout: 30000 });
        const title = await page.title();
        log(`Successfully navigated to: ${title}`);
        
        await browser.close();
        return { success: true, title };
        
    } catch (error) {
        log(`Playwright test failed: ${error.message}`, 'ERROR');
        if (browser) await browser.close();
        return { success: false, error: error.message };
    }
}

// Test Google Cloud Storage
async function testStorage() {
    try {
        log('Testing Google Cloud Storage...');
        const [buckets] = await storage.getBuckets();
        log(`Found ${buckets.length} buckets`);
        
        // Check if our profile exists
        const bucket = storage.bucket(CONFIG.BUCKET_NAME);
        const [files] = await bucket.getFiles();
        const profileExists = files.some(f => f.name === 'profile.zip');
        
        log(`Profile.zip exists: ${profileExists}`);
        return { 
            success: true, 
            bucketCount: buckets.length,
            profileExists 
        };
    } catch (error) {
        log(`Storage test failed: ${error.message}`, 'ERROR');
        return { success: false, error: error.message };
    }
}

// Test endpoint
app.get('/test', async (req, res) => {
    log('=== STARTING COMPREHENSIVE TEST ===');
    
    const results = {
        timestamp: new Date().toISOString(),
        environment: {
            NODE_ENV: process.env.NODE_ENV,
            HAS_GEMINI_KEY: !!process.env.GEMINI_API_KEY,
            BUCKET_NAME: CONFIG.BUCKET_NAME,
            PORT: port
        },
        tests: {}
    };
    
    try {
        // Test 1: Basic system
        log('Test 1: Basic system check...');
        results.tests.system = {
            nodeVersion: process.version,
            platform: process.platform,
            memory: process.memoryUsage(),
            uptime: process.uptime()
        };
        
        // Test 2: File system
        log('Test 2: File system check...');
        const tmpDir = '/tmp';
        const canWrite = fs.existsSync(tmpDir);
        results.tests.filesystem = { tmpExists: canWrite };
        
        if (canWrite) {
            const testFile = path.join(tmpDir, 'test-write.txt');
            fs.writeFileSync(testFile, 'test');
            results.tests.filesystem.canWrite = fs.existsSync(testFile);
            fs.unlinkSync(testFile);
        }
        
        // Test 3: Playwright
        log('Test 3: Playwright check...');
        results.tests.playwright = await testPlaywright();
        
        // Test 4: Storage
        log('Test 4: Google Cloud Storage check...');
        results.tests.storage = await testStorage();
        
        // Test 5: Gemini
        log('Test 5: Gemini API check...');
        try {
            const quote = await generateQuote();
            results.tests.gemini = { success: true, quote: quote.substring(0, 100) };
        } catch (error) {
            results.tests.gemini = { success: false, error: error.message };
        }
        
        log('=== TESTS COMPLETED ===');
        res.json({ success: true, results });
        
    } catch (error) {
        log(`Test endpoint error: ${error.message}`, 'ERROR');
        res.status(500).json({ 
            success: false, 
            error: error.message,
            results 
        });
    }
});

// Health endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'Google Keep Bot',
        version: '1.0.0'
    });
});

// Main Google Keep automation endpoint (SIMPLIFIED VERSION)
app.post('/scheduled-quote', async (req, res) => {
    log('=== STARTING SCHEDULED QUOTE JOB ===');
    
    try {
        // Step 1: Generate quote
        log('Generating quote...');
        const quote = await generateQuote();
        log(`Quote generated: ${quote.substring(0, 100)}...`);
        
        // Step 2: Download profile
        log('Downloading Chrome profile...');
        const bucket = storage.bucket(CONFIG.BUCKET_NAME);
        const zipPath = '/tmp/profile.zip';
        const profileDir = '/tmp/profile';
        
        // Clean up
        if (fs.existsSync(profileDir)) {
            fs.rmSync(profileDir, { recursive: true });
        }
        
        // Download
        await bucket.file('profile.zip').download({ destination: zipPath });
        log('Profile downloaded');
        
        // Extract
        fs.mkdirSync(profileDir, { recursive: true });
        await new Promise((resolve, reject) => {
            fs.createReadStream(zipPath)
                .pipe(unzipper.Extract({ path: profileDir }))
                .on('close', resolve)
                .on('error', reject);
        });
        log('Profile extracted');
        
        // Step 3: Launch browser with profile
        log('Launching browser with profile...');
        const browser = await chromium.launchPersistentContext(profileDir, {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer'
            ]
        });
        
        const page = await browser.newPage();
        
        // Step 4: Navigate to Google Keep
        log('Navigating to Google Keep...');
        await page.goto('https://keep.google.com', { 
            waitUntil: 'networkidle',
            timeout: 60000 
        });
        
        // Wait for page to load
        await page.waitForTimeout(5000);
        
        // Take screenshot for debugging
        const screenshotPath = '/tmp/keep-page.png';
        await page.screenshot({ path: screenshotPath });
        log(`Screenshot saved: ${screenshotPath}`);
        
        // Step 5: Check if logged in
        const isLoggedIn = await page.evaluate(() => {
            return !!document.querySelector('div[aria-label="Take a note"]') ||
                   !!document.querySelector('textarea');
        });
        
        if (!isLoggedIn) {
            throw new Error('Not logged into Google Keep');
        }
        
        log('Successfully logged in!');
        
        // Step 6: Create note
        log('Creating new note...');
        await page.click('div[aria-label="Take a note"]');
        await page.waitForTimeout(1000);
        
        // Type quote
        log('Typing quote...');
        await page.keyboard.type(quote);
        await page.waitForTimeout(1000);
        
        // Save note
        await page.keyboard.press('Escape');
        await page.waitForTimeout(3000);
        
        log('Note created successfully!');
        
        // Cleanup
        await browser.close();
        fs.rmSync(profileDir, { recursive: true });
        fs.unlinkSync(zipPath);
        
        log('=== JOB COMPLETED SUCCESSFULLY ===');
        
        res.json({
            success: true,
            message: 'Quote added to Google Keep',
            quote: quote,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        log(`Job failed: ${error.message}`, 'ERROR');
        log(`Stack: ${error.stack}`, 'ERROR');
        
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Quick test endpoint
app.get('/quick-test', async (req, res) => {
    log('Quick test requested');
    
    try {
        // Just test if we can launch browser
        const browser = await chromium.launch({ 
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage']
        });
        
        const page = await browser.newPage();
        await page.goto('https://example.com');
        const title = await page.title();
        
        await browser.close();
        
        res.json({
            success: true,
            message: 'Browser test passed',
            title: title,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
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
            <title>Google Keep Bot</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; }
                .button { 
                    display: inline-block; 
                    padding: 10px 20px; 
                    margin: 10px; 
                    background: #4285f4; 
                    color: white; 
                    text-decoration: none; 
                    border-radius: 5px; 
                }
                .log { background: #f5f5f5; padding: 20px; margin: 20px 0; font-family: monospace; }
            </style>
        </head>
        <body>
            <h1>🚀 Google Keep Quote Bot</h1>
            
            <h2>Quick Actions:</h2>
            <a href="/health" class="button">Health Check</a>
            <a href="/test" class="button">Run Full Test</a>
            <a href="/quick-test" class="button">Quick Browser Test</a>
            
            <h2>Test Automation:</h2>
            <button onclick="runTest()" class="button">Test /scheduled-quote</button>
            
            <div id="result" class="log"></div>
            
            <script>
                async function runTest() {
                    const resultDiv = document.getElementById('result');
                    resultDiv.innerHTML = 'Running test...';
                    
                    try {
                        const response = await fetch('/scheduled-quote', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' }
                        });
                        
                        const data = await response.json();
                        resultDiv.innerHTML = '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
                    } catch (error) {
                        resultDiv.innerHTML = 'Error: ' + error.message;
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// Start server
app.listen(port, () => {
    log(`Server started on port ${port}`);
    log(`Test endpoint: http://localhost:${port}/test`);
    log(`Health check: http://localhost:${port}/health`);
});
