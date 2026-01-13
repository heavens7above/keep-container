const express = require('express');
const { Storage } = require('@google-cloud/storage');
const { chromium } = require('playwright');
const fs = require('fs');
const unzipper = require('unzipper');

const app = express();
const port = process.env.PORT || 8080;
const storage = new Storage();

const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Configuration
const CONFIG = {
    BUCKET_NAME: process.env.BUCKET_NAME || 'keep-profile-store'
};

// Logging function
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}`;
    console.log(logMessage);
}

// ==================== HEALTH ENDPOINTS ====================

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'Google Keep Quote Bot',
        environment: {
            node: process.version,
            hasGeminiKey: !!process.env.GEMINI_API_KEY,
            bucketName: CONFIG.BUCKET_NAME
        }
    });
});

app.get('/test', async (req, res) => {
    const results = {
        timestamp: new Date().toISOString(),
        tests: {}
    };
    
    // Test 1: File system
    try {
        fs.writeFileSync('/tmp/test.txt', 'test');
        fs.unlinkSync('/tmp/test.txt');
        results.tests.filesystem = { success: true };
    } catch (error) {
        results.tests.filesystem = { success: false, error: error.message };
    }
    
    // Test 2: Storage
    try {
        const [buckets] = await storage.getBuckets();
        results.tests.storage = { 
            success: true, 
            bucketCount: buckets.length 
        };
    } catch (error) {
        results.tests.storage = { success: false, error: error.message };
    }
    
    // Test 3: Playwright
    let browser = null;
    try {
        browser = await chromium.launch({ 
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage']
        });
        results.tests.playwright = { success: true };
        await browser.close();
    } catch (error) {
        results.tests.playwright = { success: false, error: error.message };
        if (browser) await browser.close();
    }
    
    // Test 4: Gemini
    if (genAI) {
        try {
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const result = await model.generateContent("Say 'OK'");
            results.tests.gemini = { 
                success: true, 
                response: result.response.text() 
            };
        } catch (error) {
            results.tests.gemini = { success: false, error: error.message };
        }
    }
    
    res.json({ success: true, results });
});

// ==================== QUOTE GENERATION ====================

async function generateQuote() {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const prompt = `Generate a short, inspirational quote for today (${new Date().toLocaleDateString()}). 
        Make it original and thoughtful. Max 2 lines.`;
        
        const result = await model.generateContent(prompt);
        const quote = result.response.text().trim();
        log(`Generated quote: ${quote.substring(0, 100)}...`);
        return quote;
    } catch (error) {
        log(`Quote generation failed: ${error.message}`);
        return "Every day is a new beginning. Make it count. - Daily Wisdom";
    }
}

// ==================== GOOGLE KEEP AUTOMATION ====================

async function addQuoteToKeep(quote) {
    log('Starting Google Keep automation...');
    
    let browser = null;
    const profileDir = '/tmp/profile-' + Date.now();
    const zipPath = '/tmp/profile-' + Date.now() + '.zip';
    
    try {
        // 1. Download Chrome profile
        log(`Downloading profile from: ${CONFIG.BUCKET_NAME}`);
        await storage.bucket(CONFIG.BUCKET_NAME)
            .file('profile.zip')
            .download({ destination: zipPath });
        
        // 2. Extract profile
        log('Extracting profile...');
        fs.mkdirSync(profileDir, { recursive: true });
        
        await new Promise((resolve, reject) => {
            fs.createReadStream(zipPath)
                .pipe(unzipper.Extract({ path: profileDir }))
                .on('close', resolve)
                .on('error', reject);
        });
        
        // 3. Launch browser
        log('Launching browser with profile...');
        browser = await chromium.launchPersistentContext(profileDir, {
            headless: true,
            viewport: { width: 1280, height: 800 },
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
        });
        
        const page = await browser.newPage();
        
        // 4. Navigate to Google Keep
        log('Navigating to Google Keep...');
        await page.goto('https://keep.google.com', {
            waitUntil: 'networkidle',
            timeout: 30000
        });
        
        await page.waitForTimeout(5000);
        
        // 5. Create note
        log('Creating new note...');
        await page.click('div[aria-label="Take a note"]');
        await page.waitForTimeout(1000);
        
        // Type quote
        await page.keyboard.type(quote);
        await page.waitForTimeout(2000);
        
        // Save note
        await page.keyboard.press('Escape');
        await page.waitForTimeout(3000);
        
        log('Successfully added quote to Google Keep!');
        return { success: true, quote };
        
    } catch (error) {
        log(`Automation failed: ${error.message}`, 'ERROR');
        throw error;
        
    } finally {
        if (browser) await browser.close();
        
        // Cleanup
        try {
            if (fs.existsSync(profileDir)) fs.rmSync(profileDir, { recursive: true });
            if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        } catch (cleanupError) {
            log(`Cleanup error: ${cleanupError.message}`, 'WARN');
        }
    }
}

// ==================== API ENDPOINTS ====================

app.use(express.json());

// Root endpoint (for Cloud Scheduler)
app.post('/', async (req, res) => {
    log('Cloud Scheduler triggered job');
    
    try {
        const quote = await generateQuote();
        await addQuoteToKeep(quote);
        
        res.json({
            success: true,
            message: 'Daily quote added to Google Keep',
            quote: quote,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        log(`Job failed: ${error.message}`, 'ERROR');
        
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Alternative endpoint
app.post('/scheduled-quote', async (req, res) => {
    log('Alternative scheduler endpoint triggered');
    
    try {
        const quote = await generateQuote();
        await addQuoteToKeep(quote);
        
        res.json({
            success: true,
            message: 'Daily quote added via scheduled-quote endpoint',
            quote: quote,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        log(`Alternative endpoint failed: ${error.message}`, 'ERROR');
        
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Manual trigger
app.get('/add-quote', async (req, res) => {
    log('Manual trigger requested');
    
    try {
        const quote = await generateQuote();
        await addQuoteToKeep(quote);
        
        res.json({
            success: true,
            message: 'Manual quote added to Google Keep',
            quote: quote,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        log(`Manual trigger failed: ${error.message}`, 'ERROR');
        
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
                .endpoint { background: #f5f5f5; padding: 15px; margin: 10px 0; }
                .button { padding: 10px 20px; background: #4285f4; color: white; text-decoration: none; border-radius: 4px; }
            </style>
        </head>
        <body>
            <h1>Google Keep Quote Bot</h1>
            
            <h2>Endpoints:</h2>
            <div class="endpoint">
                <strong>GET /health</strong> - Health check
            </div>
            <div class="endpoint">
                <strong>GET /test</strong> - Run tests
            </div>
            <div class="endpoint">
                <strong>GET /add-quote</strong> - Manual trigger
            </div>
            <div class="endpoint">
                <strong>POST /</strong> - Cloud Scheduler endpoint
            </div>
            <div class="endpoint">
                <strong>POST /scheduled-quote</strong> - Alternative endpoint
            </div>
            
            <h2>Quick Actions:</h2>
            <a href="/health" class="button">Health Check</a>
            <a href="/test" class="button">Run Tests</a>
            <a href="/add-quote" class="button">Add Quote Now</a>
        </body>
        </html>
    `);
});

// Start server
app.listen(port, () => {
    log(`🚀 Server started on port ${port}`);
    log(`🏥 Health: http://localhost:${port}/health`);
    log(`🧪 Tests: http://localhost:${port}/test`);
    log(`⏰ Cloud Scheduler: POST to / or /scheduled-quote`);
});
