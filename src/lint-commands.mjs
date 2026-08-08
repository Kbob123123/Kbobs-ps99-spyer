// Standalone check (not part of the shipped bot) that validates every
// SlashCommandBuilder .setDescription() call across all command files stays
// under Discord's 100-character limit, WITHOUT needing discord.js installed.
// Regex-based on purpose: this only needs to catch the specific bug class
// that already broke production once (an oversized top-level command
// description), not fully parse JS.
import fs from 'node:fs';
import path from 'node:path';

const commandsDir = process.argv[2];
const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'));

let hadFailures = false;

for (const file of files) {
  const content = fs.readFileSync(path.join(commandsDir, file), 'utf8');

  // Match .setDescription('...') or .setDescription("...") — single or double
  // quoted, not template literals (those often contain dynamic values we can't
  // statically check anyway, and none of our command-level descriptions use them).
  const regex = /\.setDescription\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const raw = match[2];
    // Unescape simple JS string escapes for an accurate length count.
    const unescaped = raw.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    if (unescaped.length > 100) {
      hadFailures = true;
      console.error(`❌ ${file}: description is ${unescaped.length} chars (max 100): "${unescaped}"`);
    }
  }
}

if (hadFailures) {
  console.error('\nOne or more command/option descriptions exceed Discord\'s 100-character limit.');
  console.error('This WILL crash the bot on startup (SlashCommandBuilder validates eagerly).');
  process.exit(1);
} else {
  console.log(`✅ All ${files.length} command file(s) checked — no description length issues.`);
}
