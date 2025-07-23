// enhance.js
import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { writeToPath } from 'fast-csv';
import pLimit from 'p-limit';
import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const client = new OpenAI({ apiKey: process.env.OPENAI_KEY });
const CONCURRENCY = 5;
const ROWS_PER_BATCH = 50;


// ---- CSV Header Settings ------------------------------------
const csvHeaders = [
  'firstName','jobTitle', 'companyName',
  'website'
];

// --- Settings --------------------------------------------------------------
const myName = 'Sam';
const aiModel = 'gpt-4.1-mini'; 
// --- prompt builder ---------------------------------------------------------
function makePrompt({ firstName, title, company, website }) {
  return `You are an SDR writing the FIRST sentence of a cold email. Write one friendly icebreaker (≤25 words) for an email to ${firstName}, the ${title} at ${company}.`
       + ` Reference their site (${website}) for more information and personalization.`
       + ` The icebreaker should follow the format: "Hi {{firstName}}, my name is ${myName}, and I saw you guys work on... {whatever service they offer}."`;
}

// --- OpenAI wrapper ---------------------------------------------

async function generateIcebreaker(fields) {
  const prompt = makePrompt(fields);
  const res = await client.responses.create({
    model: aiModel,
    input: prompt,
    tools: [ { type: "web_search_preview" } ]
  });
  console.log(res.output_text);
  return res.output_text;
}

// --- CSV helpers --------------------------------------
function readCsv(file) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(file)
      .pipe(csv())
      .on('data', row => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

function writeCsv(file, rows) {
  return writeToPath(file, rows, { headers: true });
}

// --- main -------------------------------------------------------------------
async function enhanceCsv(inputFile, rowLimit = 0) {
  const rows = await readCsv(inputFile);
  const rowsToProcess = rowLimit ? rows.slice(0, rowLimit) : rows;

  const limit = pLimit(CONCURRENCY);
  const tasks = [];

  for (const row of rowsToProcess) {
    tasks.push(limit(async () => {
      try {
        const icebreaker = await generateIcebreaker({
          firstName: row[csvHeaders[0]],
          title:     row[csvHeaders[1]],
          company:   row[csvHeaders[2]],
          website:   row[csvHeaders[3]]
        });
        row.Icebreaker = icebreaker;
      } catch (err) {
        row.Icebreaker = 'Hi there,';
        console.error(`Row ${row['Email'] || '??'}:`, err.message);
      }
    }));

    // throttle per batch to stay under rate caps
    if (tasks.length % ROWS_PER_BATCH === 0) await Promise.all(tasks.splice(0));
  }
  await Promise.all(tasks);  // process remainder

  const { name, dir, ext } = path.parse(inputFile);
  const outputFile = path.join(dir, `enhanced_${name}${ext}`);
  await writeCsv(outputFile, rowsToProcess);
  console.log(`✅ Saved: ${outputFile}`);
}

// ---- CLI -------------------------------------------------------------------
const fileArg  = process.argv[2];                     // required: input CSV path
const limitArg = parseInt(process.argv[3] || '0', 10); // optional: # rows to process

if (!fileArg) {
  console.error('Usage: node enhance.js <input.csv> [rowLimit]');
  process.exit(1);
}

enhanceCsv(fileArg, isNaN(limitArg) ? 0 : limitArg).catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
