const fs = require('fs');
const path = require('path');
const glob = require('glob');
const MetricExtractor = require('./MetricExtractor');

async function run() {
    const minGrade = process.env.INPUT_MIN_GRADE || 'C';
    const workspace = process.env.GITHUB_WORKSPACE || '.';
    
    console.log(`Analyzing workspace: ${workspace}`);
    console.log(`Required minimum grade: ${minGrade}`);

    const GRADES_ORDER = ['F', 'D', 'C', 'B', 'A'];
    const minGradeIdx = GRADES_ORDER.indexOf(minGrade);

    const extractors = {
        'python': new MetricExtractor('python'),
        'javascript': new MetricExtractor('javascript'),
        'typescript': new MetricExtractor('typescript')
    };

    const files = glob.sync('**/*.{py,js,ts,jsx,tsx}', {
        cwd: workspace,
        ignore: ['**/node_modules/**', '**/test/**', '**/tests/**', '**/dist/**', '**/build/**']
    });

    let aggregate = { ad: 0, iof: 0, sldi: 0, sri: 0, pcf: 0, bmv: 0, loc: 0 };

    files.forEach(file => {
        const content = fs.readFileSync(path.join(workspace, file), 'utf8');
        let lang = 'javascript';
        if (file.endsWith('.py')) lang = 'python';
        else if (file.endsWith('.ts') || file.endsWith('.tsx')) lang = 'typescript';
        
        const m = extractors[lang].analyze(content);
        Object.keys(aggregate).forEach(k => aggregate[k] += m[k]);
    });

    if (aggregate.loc === 0) aggregate.loc = 1;

    // Simplified scoring logic for Action (calibrated to the cohort study)
    const p = (aggregate.ad / aggregate.loc) * 0.12 + (aggregate.iof / aggregate.loc) * 0.12 + (aggregate.sldi / aggregate.loc) * 0.15;
    const score = Math.max(0, Math.min(100, Math.round(100 * (1 - p * 10))));
    
    let grade = 'F';
    if (score >= 85) grade = 'A';
    else if (score >= 65) grade = 'B';
    else if (score >= 35) grade = 'C';
    else if (score >= 15) grade = 'D';

    console.log(`Final Grade: ${grade} (Score: ${score})`);

    const summary = `
## 🌱 GreenQ Sustainability Report
- **Grade:** ${grade}
- **Score:** ${score}/100
- **Total LOC Analyzed:** ${aggregate.loc}

### Metric Breakdown
- Allocation Density: ${aggregate.ad}
- I/O Frequency: ${aggregate.iof}
- Spatial Locality Degradation: ${aggregate.sldi}
- Branch Misprediction Vulnerability: ${aggregate.bmv}

[![GreenQ Grade](https://greenq.io/api/badge/${process.env.GITHUB_REPOSITORY})](https://greenq.io)
    `;

    fs.writeFileSync('greenq_summary.md', summary);
    console.log('Summary generated.');

    const gradeIdx = GRADES_ORDER.indexOf(grade);
    if (gradeIdx < minGradeIdx) {
        console.error(`Error: Grade ${grade} is below the required threshold ${minGrade}.`);
        process.exit(1);
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
