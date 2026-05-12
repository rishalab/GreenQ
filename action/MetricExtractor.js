const Parser = require('tree-sitter');
const Python = require('tree-sitter-python');
const JavaScript = require('tree-sitter-javascript');
const TypeScript = require('tree-sitter-typescript');
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const axios = require('axios');

const parser = new Parser();

const LANGUAGES = {
    'python': {
        grammar: Python,
        extensions: ['.py'],
        ioApis: ['open', 'read', 'write', 'requests.get', 'requests.post', 'socket', 'connect', 'send', 'recv', 'db.execute'],
        serializationApis: ['json.dumps', 'json.loads', 'pickle.dumps', 'pickle.loads', 'marshal.dumps', 'marshal.loads'],
        reflectionApis: ['getattr', 'setattr', 'hasattr', 'type', 'isinstance'],
        busyWaitPatterns: ['while True:', 'while 1:']
    },
    'javascript': {
        grammar: JavaScript,
        extensions: ['.js', '.jsx'],
        ioApis: ['fs.read', 'fs.write', 'fetch', 'axios', 'XMLHttpRequest', 'db.query', 'connect'],
        serializationApis: ['JSON.stringify', 'JSON.parse', 'serialize', 'deserialize'],
        reflectionApis: ['Reflect', 'Object.keys', 'Object.values', 'instanceof', 'typeof'],
        busyWaitPatterns: ['while (true)', 'while (1)']
    },
    'typescript': {
        grammar: TypeScript.typescript,
        extensions: ['.ts', '.tsx'],
        ioApis: ['fs.read', 'fs.write', 'fetch', 'axios', 'XMLHttpRequest', 'db.query', 'connect'],
        serializationApis: ['JSON.stringify', 'JSON.parse', 'serialize', 'deserialize'],
        reflectionApis: ['Reflect', 'Object.keys', 'Object.values', 'instanceof', 'typeof'],
        busyWaitPatterns: ['while (true)', 'while (1)']
    }
};

class MetricExtractor {
    constructor(lang) {
        this.lang = lang;
        this.config = LANGUAGES[lang];
        parser.setLanguage(this.config.grammar);
    }

    analyze(code) {
        const tree = parser.parse(code);
        const metrics = {
            ad: 0,
            iof: 0,
            sldi: 0,
            sri: 0,
            pcf: 0,
            bmv: 0,
            loc: code.split('\n').length
        };

        this.traverse(tree.rootNode, 0, 0, metrics);
        return metrics;
    }

    traverse(node, loopDepth, currentMetrics, metrics) {
        const isLoop = ['for_in_statement', 'while_statement', 'for_statement', 'do_statement'].includes(node.type);
        const nextLoopDepth = isLoop ? loopDepth + 1 : loopDepth;

        // AD: Allocation Density
        if (this.isAllocation(node) && loopDepth > 0) {
            metrics.ad += (1 + loopDepth);
        }

        // IOF: I/O Frequency
        if (this.isIOCall(node) && loopDepth > 0) {
            metrics.iof += (1 + loopDepth);
        }

        // SLDI: Spatial Locality Degradation
        if (this.isChainedLookup(node) && loopDepth > 0) {
            metrics.sldi += Math.pow(1 + loopDepth, 2);
        }

        // SRI: Serialization & Reflection
        if (this.isSerializationOrReflection(node)) {
            metrics.sri += (1 + loopDepth);
        }

        // PCF: Polling & Contention
        if (this.isBusyLoop(node)) {
            metrics.pcf += (1 + this.getNodeComplexity(node));
        }
        if (this.isUnpooledThread(node)) {
            metrics.pcf += 10;
        }

        // BMV: Branch Misprediction
        if (this.isConditional(node) && loopDepth > 0) {
            metrics.bmv += Math.pow(2, loopDepth);
        }

        for (let i = 0; i < node.childCount; i++) {
            this.traverse(node.child(i), nextLoopDepth, currentMetrics, metrics);
        }
    }

    isAllocation(node) {
        if (this.lang === 'python') {
            // Python allocations are usually Call nodes where the identifier starts with an uppercase letter
            // This is a heuristic.
            if (node.type === 'call') {
                const func = node.childForFieldName('function');
                if (func && func.type === 'identifier') {
                    const name = func.text;
                    return /^[A-Z]/.test(name);
                }
            }
        } else {
            return node.type === 'new_expression';
        }
        return false;
    }

    isIOCall(node) {
        if (node.type === 'call' || node.type === 'call_expression') {
            const text = node.text;
            return this.config.ioApis.some(api => text.includes(api));
        }
        return false;
    }

    isChainedLookup(node) {
        // Look for multiple attribute accesses or member expressions
        if (node.type === 'attribute' || node.type === 'member_expression') {
            let depth = 0;
            let current = node;
            while (current && (current.type === 'attribute' || current.type === 'member_expression')) {
                depth++;
                current = current.child(0);
            }
            return depth >= 2;
        }
        return false;
    }

    isSerializationOrReflection(node) {
        if (node.type === 'call' || node.type === 'call_expression') {
            const text = node.text;
            return [...this.config.serializationApis, ...this.config.reflectionApis].some(api => text.includes(api));
        }
        return false;
    }

    isBusyLoop(node) {
        if (node.type === 'while_statement') {
            const condition = node.childForFieldName('condition');
            if (condition && (condition.text === 'True' || condition.text === '1' || condition.text === 'true')) {
                // Check if it has sleep or await
                const body = node.childForFieldName('body');
                if (body && !body.text.includes('sleep') && !body.text.includes('await')) {
                    return true;
                }
            }
        }
        return false;
    }

    isUnpooledThread(node) {
        if (node.type === 'call' || node.type === 'call_expression') {
            const text = node.text;
            if (this.lang === 'python') return text.includes('threading.Thread');
            if (this.lang === 'javascript' || this.lang === 'typescript') return text.includes('new Worker');
        }
        return false;
    }

    isConditional(node) {
        return ['if_statement', 'switch_statement', 'conditional_expression'].includes(node.type);
    }

    getNodeComplexity(node) {
        // Simple heuristic for complexity: count nodes in subtree
        return node.descendantCount / 10;
    }
}

module.exports = MetricExtractor;
