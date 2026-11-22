'use strict';
// Minimal studiomdl header reader (studiohdr_t, MDL versions 44-49):
// texture names, texture search dirs ($cdmaterials), skin families and $includemodel references.

const HDR_SIZE = 408;

function parseMDL(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HDR_SIZE) return null;
  if (buf.toString('latin1', 0, 4) !== 'IDST') return null;
  const version = buf.readInt32LE(4);
  if (version < 44 || version > 49) return null;

  const i32 = (o) => (o >= 0 && o + 4 <= buf.length ? buf.readInt32LE(o) : 0); // a negative offset (hostile file) reads as 0, never throws
  const cstr = (off) => {
    if (off <= 0 || off >= buf.length) return '';
    let end = buf.indexOf(0, off);
    if (end === -1) end = buf.length;
    return buf.toString('latin1', off, end);
  };
  const count = (n) => (n > 0 && n < 4096 ? n : 0);

  const numTextures = count(i32(204)), textureIndex = i32(208);
  const numCd = count(i32(212)), cdIndex = i32(216);
  const numSkinRef = count(i32(220)), numSkinFamilies = count(i32(224)), skinIndex = i32(228);
  const numInc = count(i32(336)), incIndex = i32(340);

  const textures = []; // index-aligned with the MDL texture table ('' when unreadable)
  for (let i = 0; i < numTextures; i++) {
    const base = textureIndex + i * 64; // sizeof(mstudiotexture_t)
    textures.push(base + 64 <= buf.length ? cstr(base + i32(base)) : '');
  }
  const textureDirs = [];
  for (let i = 0; i < numCd; i++) {
    const o = cdIndex + i * 4;
    if (o + 4 > buf.length) break;
    textureDirs.push(cstr(i32(o)));
  }
  // skin families: numSkinFamilies rows of numSkinRef int16 texture indices
  const skins = [];
  if (skinIndex > 0 && skinIndex + numSkinFamilies * numSkinRef * 2 <= buf.length) {
    for (let f = 0; f < numSkinFamilies; f++) {
      const row = [];
      for (let r = 0; r < numSkinRef; r++) row.push(buf.readInt16LE(skinIndex + (f * numSkinRef + r) * 2));
      skins.push(row);
    }
  }
  const includeModels = [];
  for (let i = 0; i < numInc; i++) {
    const base = incIndex + i * 8; // sizeof(mstudiomodelgroup_t)
    if (base + 8 > buf.length) break;
    const s = cstr(base + i32(base + 4));
    if (s) includeModels.push(s);
  }
  // Material slots the meshes really use (bodyparts -> models -> meshes). A skin family row has one entry per slot,
  // including the slots that only exist to hold the alternative textures of other skins.
  let meshSlots = new Set();
  try {
    const numBody = count(i32(232)), bodyIndex = i32(236);
    for (let b = 0; b < numBody; b++) {
      const bp = bodyIndex + b * 16; // mstudiobodyparts_t
      if (bp + 16 > buf.length) throw new Error('bodypart out of range');
      const numModels = count(i32(bp + 4)), modelIndex = bp + i32(bp + 12);
      for (let m = 0; m < numModels; m++) {
        const mo = modelIndex + m * 148; // mstudiomodel_t
        if (mo + 148 > buf.length) throw new Error('model out of range');
        const numMeshes = count(i32(mo + 72)), meshIndex = mo + i32(mo + 76);
        for (let k = 0; k < numMeshes; k++) {
          const me = meshIndex + k * 116; // mstudiomesh_t, first field = material slot
          if (me + 4 > buf.length) throw new Error('mesh out of range');
          meshSlots.add(i32(me));
        }
      }
    }
  } catch { meshSlots = new Set(); } // unknown layout: every slot counts
  // sanity: a slot outside the skin table means we misread the file -> do not prune on that basis
  for (const s of meshSlots) if (s < 0 || s >= Math.max(numSkinRef, 1)) { meshSlots = new Set(); break; }

  // $keyvalues text (prop_data, break / gib models, particle attachments...)
  const kvIndex = i32(312), kvSize = i32(316);
  const keyvalues = kvIndex > 0 && kvSize > 0 && kvSize < (1 << 20) && kvIndex + kvSize <= buf.length ? buf.toString('latin1', kvIndex, kvIndex + kvSize) : '';
  return { version, name: cstr(12), textures, textureDirs, skins, includeModels, keyvalues, meshSlots };
}

/**
 * Texture indices actually used by a set of skins (null = every texture).
 * @param {{textures:string[], skins:number[][]}} info
 * @param {Iterable<number>|null} usedSkins
 */
function texturesForSkins(info, usedSkins) {
  if (!usedSkins || !info.skins.length) return null;
  const out = new Set();
  for (const s of usedSkins) {
    if (s < 0) return null; // unknown skin: keep everything
    const row = info.skins[s < info.skins.length ? s : 0];
    const slots = info.meshSlots && info.meshSlots.size ? info.meshSlots : null;
    row.forEach((t, slot) => { if ((!slots || slots.has(slot)) && t >= 0 && t < info.textures.length) out.add(t); });
  }
  return out.size ? out : null;
}

/** Material names a .vtx swaps in for its lower LODs ($lod ... replacematerial): needed whatever the skin. */
function vtxReplacementMaterials(buf) {
  const out = [];
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 36) return out;
    const numLODs = buf.readInt32LE(20), list = buf.readInt32LE(24);
    if (numLODs <= 0 || numLODs > 32 || list <= 0) return out;
    for (let l = 0; l < numLODs; l++) {
      const h = list + l * 8;
      if (h + 8 > buf.length) break;
      const n = buf.readInt32LE(h), base = h + buf.readInt32LE(h + 4);
      for (let i = 0; i < n && i < 256; i++) {
        const r = base + i * 6; // packed { short materialID; int nameOffset }
        if (r + 6 > buf.length) break;
        const at = r + buf.readInt32LE(r + 2);
        if (at <= 0 || at >= buf.length) continue;
        let end = buf.indexOf(0, at); if (end === -1 || end - at > 260) continue;
        const name = buf.toString('latin1', at, end);
        if (name) out.push(name);
      }
    }
  } catch { /* odd vtx: no replacement known */ }
  return [...new Set(out)];
}

module.exports = { parseMDL, texturesForSkins, vtxReplacementMaterials };
