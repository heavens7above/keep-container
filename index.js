const express = require('express');
const { Storage } = require('@google-cloud/storage');
const { chromium } = require('playwright');
const fs = require('fs');
const unzipper = require('unzipper');

const app = express();
const port = process.env.PORT || 8080;
const storage = new Storage();

app.get('/', async (req, res) => {
    try {
        const bucketName = 'keep-profile-store';
        const zipPath = '/tmp/profile.zip';
        const profileDir = '/tmp/profile';

        // Download profile zip
        await storage
            .bucket(bucketName)
            .file('profile.zip')
            .download({ destination: zipPath });

        // Unzip profile
        await fs.createReadStream(zipPath)
            .pipe(unzipper.Extract({ path: profileDir }))
            .promise();

        // Launch Chromium with saved profile
        const context = await chromium.launchPersistentContext(profileDir, {
            headless: true,
            viewport: { width: 1280, height: 800 }
        });

        const page = await context.newPage();
        await page.goto('https://keep.google.com', { waitUntil: 'networkidle' });
        await page.waitForTimeout(5000);

        await context.close();

        res.send('Keep auth test completed successfully');
    } catch (err) {
        console.error(err);
        res.status(500).send(err.toString());
    }
});

app.listen(port, () => {
    console.log(`Listening on port ${port}`);
});