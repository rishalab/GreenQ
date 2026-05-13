const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const MetricExtractor = require('./MetricExtractor');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const GRADES = {
    'A': { color: '#4c1', score: 100 },
    'B': { color: '#97ca00', score: 99 },
    'C': { color: '#dfb317', score: 91 },
    'D': { color: '#a3712f', score: 75 },
    'F': { color: '#e05d44', score: 0 }
};

const METRIC_MAP = {
    'ad': 'Allocation Density',
    'iof': 'I/O Frequency Index',
    'sldi': 'Spatial Locality',
    'sri': 'Serialization Intensity',
    'pcf': 'Polling Factor',
    'bmv': 'Branch Prediction',
    'dfl': 'Dependency Footprint',
    'edbf': 'Dependency Bloat'
};

function getGrade(score) {
    if (score >= 100) return 'A';
    if (score >= 99) return 'B';
    if (score >= 91) return 'C';
    if (score >= 75) return 'D';
    return 'F';
}

function generateBadgeSVG(label, grade) {
    const config = GRADES[grade] || GRADES['C'];
    const labelWidth = label.length * 7 + 12;
    const valueWidth = 35;
    const totalWidth = labelWidth + valueWidth;

    return `
<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20">
  <linearGradient id="b" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <mask id="a">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </mask>
  <g mask="url(#a)">
    <path fill="#555" d="M0 0h${labelWidth}v20H0z"/>
    <path fill="${config.color}" d="M${labelWidth} 0h${valueWidth}v20H${labelWidth}z"/>
    <path fill="url(#b)" d="M0 0h${totalWidth}v20H0z"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelWidth / 2}" y="14">${label}</text>
    <text x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${grade}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${grade}</text>
  </g>
</svg>`.trim();
}

async function getDependencySize(pkg, lang) {
    try {
        if (lang === 'javascript' || lang === 'typescript') {
            const res = await axios.get(`https://registry.npmjs.org/${pkg}/latest`, { timeout: 5000 });
            return res.data.dist.unpackedSize || 1024 * 1024;
        } else if (lang === 'python') {
            const res = await axios.get(`https://pypi.org/pypi/${pkg}/json`, { timeout: 5000 });
            const version = res.data.info.version;
            const releases = res.data.releases[version] || [];
            let size = 0;
            releases.forEach(r => size += r.size);
            return size || 512 * 1024;
        }
    } catch (e) {}
    return 500000;
}

app.get('/api/static-badge/:metric/:grade', (req, res) => {
    const metricKey = req.params.metric.toLowerCase();
    const grade = req.params.grade.toUpperCase();
    const label = METRIC_MAP[metricKey] || 'Sustainability';
    const validGrades = ['A', 'B', 'C', 'D', 'F'];
    const finalGrade = validGrades.includes(grade) ? grade : 'C';
    
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(generateBadgeSVG(label, finalGrade));
});

app.post('/api/analyze', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    console.log(`Analyzing: ${url}`);
    const parts = url.replace('https://github.com/', '').split('/');
    const user = parts[0];
    const repo = parts[1];

    try {
        const repoMeta = await axios.get(`https://api.github.com/repos/${user}/${repo}`);
        const defaultBranch = repoMeta.data.default_branch || 'main';

        const treeRes = await axios.get(`https://api.github.com/repos/${user}/${repo}/git/trees/${defaultBranch}?recursive=1`);
        if (!treeRes.data || !treeRes.data.tree) {
            throw new Error('Could not fetch repository tree');
        }

        const codeFiles = treeRes.data.tree
            .filter(f => f.type === 'blob')
            .filter(f => f.path.endsWith('.py') || f.path.endsWith('.js') || f.path.endsWith('.ts'))
            .filter(f => !f.path.includes('/test/') && !f.path.includes('/tests/') && !f.path.includes('/dist/') && !f.path.includes('/build/'))
            .sort((a, b) => a.path.localeCompare(b.path))
            .slice(0, 100);

        const extractors = {
            'python': new MetricExtractor('python'),
            'javascript': new MetricExtractor('javascript'),
            'typescript': new MetricExtractor('typescript')
        };

        let aggregate = { 
            ad: 0, iof: 0, sldi: 0, sri: 0, pcf: 0, bmv: 0, loc: 0,
            dependencySize: 0, referencedSymbols: 0, totalSymbols: 0
        };

        let primaryLang = 'javascript';
        if (codeFiles.some(f => f.path.endsWith('.py'))) primaryLang = 'python';
        else if (codeFiles.some(f => f.path.endsWith('.ts'))) primaryLang = 'typescript';

        for (const file of codeFiles) {
            try {
                const rawRes = await axios.get(`https://raw.githubusercontent.com/${user}/${repo}/${defaultBranch}/${file.path}`);
                const code = rawRes.data;
                
                let lang = 'javascript';
                if (file.path.endsWith('.py')) lang = 'python';
                else if (file.path.endsWith('.ts')) lang = 'typescript';

                const m = extractors[lang].analyze(code);
                Object.keys(m).forEach(k => {
                    if (aggregate.hasOwnProperty(k)) aggregate[k] += m[k];
                });
                aggregate.loc += m.loc;

                // EDBF heuristics
                aggregate.referencedSymbols += (code.match(/import|from|require/g) || []).length;
                aggregate.totalSymbols += 50; 
            } catch (e) {
                console.warn(`Failed to fetch ${file.path}: ${e.message}`);
            }
        }

        // Dependency Analysis
        let deps = [];
        try {
            if (primaryLang === 'python') {
                const reqRes = await axios.get(`https://raw.githubusercontent.com/${user}/${repo}/${defaultBranch}/requirements.txt`);
                deps = reqRes.data.split('\n').map(l => l.split('==')[0].split('>')[0].trim()).filter(l => l && !l.startsWith('#'));
            } else {
                const pkgRes = await axios.get(`https://raw.githubusercontent.com/${user}/${repo}/${defaultBranch}/package.json`);
                deps = Object.keys(pkgRes.data.dependencies || {});
            }
        } catch (e) {}

        for (const dep of deps.slice(0, 5)) {
            aggregate.dependencySize += await getDependencySize(dep, primaryLang === 'python' ? 'python' : 'javascript');
        }

        if (aggregate.loc === 0) aggregate.loc = 1;

        const ad_norm = Math.min(1, (aggregate.ad / aggregate.loc) / 0.0117);
        const iof_norm = Math.min(1, (aggregate.iof / aggregate.loc) / 0.1818);
        const sldi_norm = Math.min(1, (aggregate.sldi / aggregate.loc) / 0.3636);
        const sri_norm = Math.min(1, (aggregate.sri / aggregate.loc) / 0.0471);
        const pcf_norm = Math.min(1, (aggregate.pcf / aggregate.loc) / 0.0499);
        const bmv_norm = Math.min(1, (aggregate.bmv / aggregate.loc) / 0.0869);
        
        const dfl = aggregate.dependencySize / aggregate.loc;
        const dfl_norm = Math.min(1, dfl / 500); 
        const edbf_norm = dfl_norm * (1 - (aggregate.referencedSymbols / Math.max(aggregate.totalSymbols, 1)));

        // Individual grades
        const metricGrades = {
            ad: getGrade(Math.round(100 * (1 - ad_norm))),
            iof: getGrade(Math.round(100 * (1 - iof_norm))),
            sldi: getGrade(Math.round(100 * (1 - sldi_norm))),
            sri: getGrade(Math.round(100 * (1 - sri_norm))),
            pcf: getGrade(Math.round(100 * (1 - pcf_norm))),
            bmv: getGrade(Math.round(100 * (1 - bmv_norm))),
            dfl: getGrade(Math.round(100 * (1 - dfl_norm))),
            edbf: getGrade(Math.round(100 * (1 - edbf_norm)))
        };

        const p = 0.12 * ad_norm + 
                  0.12 * iof_norm + 
                  0.10 * dfl_norm +
                  0.15 * sldi_norm + 
                  0.13 * sri_norm + 
                  0.10 * pcf_norm + 
                  0.13 * bmv_norm +
                  0.15 * edbf_norm;

        const score = Math.round(100 * (1 - p));
        const grade = getGrade(score);

        const finalMetrics = {
            ad: aggregate.ad, iof: aggregate.iof, sldi: aggregate.sldi,
            sri: aggregate.sri, pcf: aggregate.pcf, bmv: aggregate.bmv,
            dfl: dfl, edbf: edbf_norm
        };

        res.json({ user, repo, score, grade, metricGrades, metrics: finalMetrics });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Analysis failed: ' + e.message });
    }
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`GreenQ Server running on http://localhost:${PORT}`);
    });
}

module.exports = app;
