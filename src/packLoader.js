'use strict';

const fs = require('fs');
const path = require('path');

const PACKS_DIR = path.join(__dirname, '..', 'data', 'packs');

function listPacks() {
  if (!fs.existsSync(PACKS_DIR)) return [];
  return fs
    .readdirSync(PACKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const full = path.join(PACKS_DIR, f);
      try {
        const data = JSON.parse(fs.readFileSync(full, 'utf8'));
        validatePack(data);
        return {
          file: f,
          packId: data.packId,
          packName: data.packName,
          clipCount: data.clips.length,
        };
      } catch (err) {
        console.warn(`[packLoader] Ignoriere ungültiges Pack "${f}": ${err.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

function loadPack(packId) {
  const packs = fs.readdirSync(PACKS_DIR).filter((f) => f.endsWith('.json'));
  for (const file of packs) {
    const full = path.join(PACKS_DIR, file);
    const data = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (data.packId === packId) {
      validatePack(data);
      return data.clips;
    }
  }
  throw new Error(`Pack "${packId}" nicht gefunden.`);
}

function validatePack(data) {
  if (!data.packId || !data.packName || !Array.isArray(data.clips)) {
    throw new Error('Pack braucht packId, packName und clips[].');
  }
  for (const clip of data.clips) {
    if (!clip.id || !clip.youtubeId) {
      throw new Error(`Clip "${clip.id || '?'}" ist unvollständig (id, youtubeId nötig).`);
    }
    if (typeof clip.startTime !== 'number' || typeof clip.endTime !== 'number' || clip.endTime <= clip.startTime) {
      throw new Error(`Clip "${clip.id}" hat ungültige startTime/endTime.`);
    }
  }
}

module.exports = { listPacks, loadPack, PACKS_DIR };
