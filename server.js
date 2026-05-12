const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const MetricExtractor = require('./MetricExtractor');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

const GRADES = {
    'A': { color: '#4c1', score: 85 },
    'B': { color: '#97ca00', score: 65 },
    'C': { color: '#dfb317', score: 35 },
    'D': { color: '#a3712f', score: 15 },
    'F': { color: '#e05d44', score: 0 }
};

function getGrade(score) {
    if (score >= 85) return 'A';
    if (score >= 65) return 'B';
    if (score >= 35) return 'C';
    if (score >= 15) return 'D';
    return 'F';
}

function generateBadgeSVG(grade, score) {
    const config = GRADES[grade];
    return `
<svg xmlns="http://www.w3.org/2000/svg" width="110" height="20">
  <linearGradient id="b" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <mask id="a">
    <rect width="110" height="20" rx="3" fill="#fff"/>
  </mask>
  <g mask="url(#a)">
    <path fill="#555" d="M0 0h75v20H0z"/>
    <path fill="${config.color}" d="M75 0h35v20H75z"/>
    <path fill="url(#b)" d="M0 0h110v20H0z"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="37.5" y="15" fill="#010101" fill-opacity=".3">GreenQ</text>
    <text x="37.5" y="14">GreenQ</text>
    <text x="92.5" y="15" fill="#010101" fill-opacity=".3">${grade}</text>
    <text x="92.5" y="14">${grade}</text>
  </g>
</svg>`.trim();
}

// Mock database for cached results
const cache = new Map();

app.get('/api/badge/:user/:repo', (req, res) => {
    const key = `${req.params.user}/${req.params.repo}`;
    const result = cache.get(key) || { grade: 'C', score: 50 }; // Default if not found
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(generateBadgeSVG(result.grade, result.score));
});

app.post('/api/analyze', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    console.log(`Analyzing: ${url}`);
    const parts = url.replace('https://github.com/', '').split('/');
    const user = parts[0];
    const repo = parts[1];

    try {
        // Get default branch first
        const repoMeta = await axios.get(`https://api.github.com/repos/${user}/${repo}`);
        const defaultBranch = repoMeta.data.default_branch || 'main';

        // Fetch files via GitHub API (Recursive Tree) using default branch
        const treeRes = await axios.get(`https://api.github.com/repos/${user}/${repo}/git/trees/${defaultBranch}?recursive=1`);
        const codeFiles = treeRes.data.tree.filter(f => f.path.endsWith('.py') || f.path.endsWith('.js') || f.path.endsWith('.ts')).slice(0, 100);

        const extractors = {
            'python': new MetricExtractor('python'),
            'javascript': new MetricExtractor('javascript'),
            'typescript': new MetricExtractor('typescript')
        };

        let aggregate = { ad: 0, iof: 0, sldi: 0, sri: 0, pcf: 0, bmv: 0, loc: 0 };

        for (const file of codeFiles) {
            try {
                const rawRes = await axios.get(`https://raw.githubusercontent.com/${user}/${repo}/${defaultBranch}/${file.path}`);
                const code = rawRes.data;
                
                let lang = 'javascript';
                if (file.path.endsWith('.py')) lang = 'python';
                else if (file.path.endsWith('.ts')) lang = 'typescript';

                const m = extractors[lang].analyze(code);
                Object.keys(aggregate).forEach(k => aggregate[k] += m[k]);
            } catch (e) {
                console.warn(`Failed to fetch ${file.path}: ${e.message}`);
            }
        }

        if (aggregate.loc === 0) aggregate.loc = 1;

        // More robust normalization for single-repo analysis
        const ad_norm = Math.min(1, (aggregate.ad / aggregate.loc) / 0.1);
        const iof_norm = Math.min(1, (aggregate.iof / aggregate.loc) / 0.05);
        const sldi_norm = Math.min(1, (aggregate.sldi / aggregate.loc) / 0.5);
        const bmv_norm = Math.min(1, (aggregate.bmv / aggregate.loc) / 0.5);
        const sri_norm = Math.min(1, (aggregate.sri / aggregate.loc) / 0.2);

        const p = 0.15 * ad_norm + 0.15 * iof_norm + 0.20 * sldi_norm + 0.25 * bmv_norm + 0.25 * sri_norm;
        const score = Math.max(0, Math.min(100, Math.round(100 * (1 - p))));
        const grade = getGrade(score);

        const result = { user, repo, score, grade, metrics: aggregate };
        cache.set(`${user}/${repo}`, result);
        res.json(result);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Analysis failed: ' + e.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`GreenQ Server running on http://localhost:${PORT}`);
});
