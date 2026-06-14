/**
 * Patch @make-software/cspr-trade-mcp-sdk for Node.js v26 ESM compatibility
 * 
 * The SDK uses named imports from casper-js-sdk (CommonJS) which doesn't work
 * in Node.js v26. This script patches the imports to use default import.
 */
const fs = require('fs');
const path = require('path');

const sdkPath = path.join(__dirname, '../node_modules/@make-software/cspr-trade-mcp-sdk/dist/index.js');

let content = fs.readFileSync(sdkPath, 'utf8');

// Find all unique named imports from casper-js-sdk
const importRegex = /import \{ ([^}]+) \} from "casper-js-sdk";/g;
const imports = new Set();
let match;
while ((match = importRegex.exec(content)) !== null) {
  match[1].split(',').forEach(name => imports.add(name.trim()));
}

console.log('Found imports:', Array.from(imports).join(', '));

// Add a single default import at the top of the file
const defaultImport = `import __casperSdk from "casper-js-sdk";\nconst { ${Array.from(imports).join(', ')} } = __casperSdk;\n`;

// Remove all individual imports
content = content.replace(/import \{ [^}]+ \} from "casper-js-sdk";\n/g, '');

// Add the default import after the first import statement
const firstImportIndex = content.indexOf('import ');
if (firstImportIndex !== -1) {
  const lineEnd = content.indexOf('\n', firstImportIndex);
  content = content.slice(0, lineEnd + 1) + defaultImport + content.slice(lineEnd + 1);
} else {
  content = defaultImport + content;
}

fs.writeFileSync(sdkPath, content);
console.log('Patched:', sdkPath);
