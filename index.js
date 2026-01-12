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

// Logging function
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`);
}

// Simple health check
app.get('/health', (req, res) => {
    log('Health check requested');
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'Google Keep Bot',
        environment: {
            node: process.version,
            hasGeminiKey: !!process.env.GEMINI_API_KEY,
            bucketName: process.env.BUCKET_NAME || 'not-set'
        }
    });
});

// Test Playwright installation
app.get('/test-playwright', async (req, res) => {
    log('Testing Playwright installation');
    
    let browser = null;
    try {
        browser = await chromium.launch({ 
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage']
        });
        
        const page = await browser.newPage();
        await page.goto('https://example.com');
        const title = await page.title();
        
        await browser.close();
        
        res.json({
            success: true,
            message: 'Playwright is working!',
            title: title
        });
        
    } catch (error) {
        if (browser) await browser.close();
        
        res.status(500).json({
            success: false,
            error: error.message,
            message: 'Playwright test failed'
        });
    }
});

// Test Cloud Storage
app.get('/test-storage', async (req, res) => {
    log('Testing Cloud Storage');
    
    try {
        const [buckets] = await storage.getBuckets();
        const bucketName = process.env.BUCKET_NAME || 'keep-profile-store';
        const bucket = storage.bucket(bucketName);
        
        // Check if profile exists
        const [files] = await bucket.getFiles();
        const profileExists = files.some(f => f.name === 'profile.zip');
        
        res.json({
            success: true,
            bucketCount: buckets.length,
            profileExists: profileExists,
            files: files.map(f => f.name)
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Generate quote endpoint
app.get('/generate-quote', async (req, res) => {
    log('Generating quote');
    
    try {
        if (!process.env.GEMINI_API_KEY) {
            throw new Error('GEMINI_API_KEY not set');
        }
        
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = "Generate a short, inspirational quote about technology and life.";
        const result = await model.generateContent(prompt);
        const quote = result.response.text().trim();
        
        res.json({
            success: true,
            quote: quote
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            fallbackQuote: "The only way to do great work is to love what you do. - Steve Jobs"
        });
    }
});

// Main automation endpoint
app.post('/scheduled-quote', async (req, res) => {
    log('Starting scheduled quote job');
    
    try {
        // 1. Generate quote
        log('Step 1: Generating quote');
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = "Generate a short, inspirational quote for today. Make it unique.";
        const result = await model.generateContent(prompt);
        const quote = result.response.text().trim();
        
        log(`Generated quote: ${quote.substring(0, 100)}...`);
        
        // 2. Download Chrome profile
        log('Step 2: Downloading Chrome profile');
        const bucketName = process.env.BUCKET_NAME || 'keep-profile-store';
        const zipPath = '/tmp/profile.zip';
        const profileDir = '/tmp/profile';
        
        // Clean up old files
        if (fs.existsSync(profileDir)) {
            fs.rmSync(profileDir, { recursive: true });
        }
        if (fs.existsSync(zipPath)) {
            fs.unlinkSync(zipPath);
        }
        
        // Download from GCS
        await storage.bucket(bucketName)
            .file('profile.zip')
            .download({ destination: zipPath });
        
        // Extract
        fs.mkdirSync(profileDir, { recursive: true });
        await new Promise((resolve, reject) => {
            fs.createReadStream(zipPath)
                .pipe(unzipper.Extract({ path: profileDir }))
                .on('close', resolve)
                .on('error', reject);
        });
        
        // 3. Launch browser with profile
        log('Step 3: Launching browser');
        const browser = await chromium.launchPersistentContext(profileDir, {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ],
            viewport: { width: 1280, height: 720 }
        });
        
        const page = await browser.newPage();
        
        // 4. Navigate to Google Keep
        log('Step 4: Navigating to Google Keep');
        await page.goto('https://keep.google.com', {
            waitUntil: 'networkidle',
            timeout: 30000
        });
        
        // Wait for page to load
        await page.waitForTimeout(5000);
        
        // Take screenshot for debugging
        const screenshotPath = '/tmp/keep-screenshot.png';
        await page.screenshot({ path: screenshotPath });
        log(`Screenshot saved to ${screenshotPath}`);
        
        // 5. Create note
        log('Step 5: Creating note');
        
        // Try to find and click the "Take a note" button
        const noteButton = await page.$('div[aria-label="Take a note"]') ||
                          await page.$('div[role="button"][aria-label*="Take"]') ||
                          await page.$('textarea[aria-label="Note"]');
        
        if (noteButton) {
            await noteButton.click();
            await page.waitForTimeout(1000);
        } else {
            // Fallback: use keyboard shortcut
            await page.keyboard.press('c');
            await page.waitForTimeout(1000);
        }
        
        // Type the quote
        await page.keyboard.type(quote);
        await page.waitForTimeout(1000);
        
        // Save note (Escape key)
        await page.keyboard.press('Escape');
        await page.waitForTimeout(3000);
        
        // 6. Cleanup
        log('Step 6: Cleaning up');
        await browser.close();
        
        // Remove profile files
        fs.rmSync(profileDir, { recursive: true });
        fs.unlinkSync(zipPath);
        
        log('Job completed successfully!');
        
        res.json({
            success: true,
            message: 'Quote added to Google Keep',
            quote: quote,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        log(`Job failed: ${error.message}`);
        log(`Stack: ${error.stack}`);
        
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Home page with test links
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Google Keep Bot</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; }
                h1 { color: #4285f4; }
                .test-box { 
                    background: #f5f5f5; 
                    padding: 15px; 
                    margin: 10px 0; 
                    border-radius: 5px;
                    border-left: 4px solid #4285f4;
                }
                button { 
                    padding: 10px 20px; 
                    background: #4285f4; 
                    color: white; 
                    border: none; 
                    border-radius: 4px; 
                    cursor: pointer;
                    margin: 5px;
                }
                button:hover { background: #3367d6; }
                #result { 
                    background: #e8f5e9; 
                    padding: 15px; 
                    margin: 20px 0; 
                    border-radius: 5px;
                    display: none;
                }
                pre { background: #263238; color: white; padding: 15px; border-radius: 5px; overflow: auto; }
            </style>
        </head>
        <body>
            <h1>🚀 Google Keep Quote Bot</h1>
            <p>Automatically add AI-generated quotes to Google Keep</p>
            
            <div class="test-box">
                <h3>1. Health Check</h3>
                <button onclick="testEndpoint('/health')">Test Health</button>
            </div>
            
            <div class="test-box">
                <h3>2. Test Playwright</h3>
                <button onclick="testEndpoint('/test-playwright')">Test Browser</button>
            </div>
            
            <div class="test-box">
                <h3>3. Test Storage</h3>
                <button onclick="testEndpoint('/test-storage')">Test Cloud Storage</button>
            </div>
            
            <div class="test-box">
                <h3>4. Test Gemini</h3>
                <button onclick="testEndpoint('/generate-quote')">Generate Test Quote</button>
            </div>
            
            <div class="test-box">
                <h3>5. Run Full Automation</h3>
                <button onclick="runAutomation()">Add Quote to Google Keep</button>
                <p><small>This will actually add a quote to your Google Keep</small></p>
            </div>
            
            <div id="result"></div>
            
            <script>
                async function testEndpoint(url) {
                    const resultDiv = document.getElementById('result');
                    resultDiv.style.display = 'block';
                    resultDiv.innerHTML = '<p>Testing... ⏳</p>';
                    
                    try {
                        const response = await fetch(url);
                        const data = await response.json();
                        resultDiv.innerHTML = '<h4>Result:</h4><pre>' + JSON.stringify(data, null, 2) + '</pre>';
                    } catch (error) {
                        resultDiv.innerHTML = '<h4>Error:</h4><pre>' + error.message + '</pre>';
                    }
                }
                
                async function runAutomation() {
                    const resultDiv = document.getElementById('result');
                    resultDiv.style.display = 'block';
                    resultDiv.innerHTML = '<p>Running automation... This may take 30-60 seconds ⏳</p>';
                    
                    try {
                        const response = await fetch('/scheduled-quote', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' }
                        });
                        
                        const data = await response.json();
                        if (data.success) {
                            resultDiv.innerHTML = '<h4>✅ Success!</h4><pre>' + JSON.stringify(data, null, 2) + '</pre>';
                        } else {
                            resultDiv.innerHTML = '<h4>❌ Failed</h4><pre>' + JSON.stringify(data, null, 2) + '</pre>';
                        }
                    } catch (error) {
                        resultDiv.innerHTML = '<h4>❌ Error:</h4><pre>' + error.message + '</pre>';
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// Start server
app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log(`🌐 Open http://localhost:${port} to test`);
    console.log(`🏥 Health check: http://localhost:${port}/health`);
});
