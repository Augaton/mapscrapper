'use strict';
// Key lists used to classify VMF / VMT key-value pairs.
// Everything is validated against the disk afterwards, so over-inclusion is harmless.

// VMT keys whose value is a texture (materials/<value>.vtf). Leading $ / % already stripped.
const VMT_TEXTURE_KEYS = new Set([ "albedo", "alphamasktexture", "ambientoccltexture", "ambientocclusiontexture", "basetexture", "basetexture2", "basetexture3", "basetexture4", "basetexturenoenvmap", "blendmasktexture", "blendmodulatetexture", "bloomtexture", "bottommaterial_texture", "bumpcompress", "bumpmap", "bumpmap2", "bumpmask", "bumpstretch", "burndetailtexture", "cbtexture", "cloakcolortint", "colorwarp", "colorwarptexture", "compress", "cookietexture", "corneatexture", "crtexture", "cutouttexture", "depth_texture", "detail", "detail1", "detail2", "diffuse_texture", "diffusewarp", "displacementmap", "dudvmap", "effectmaskstexture", "emissiveblendbasetexture", "emissiveblendflowtexture", "emissiveblendmasktexture", "emissiveblendtexture", "envmap", "envmapmask", "exposure_texture", "fbtexture", "fleshbordertexture1d", "fleshcubetexture", "fleshinteriornoisetexture", "fleshinteriortexture", "fleshnormaltexture", "fleshsubsurfacetexture", "flow_noise_texture", "flowmap", "fow", "fow_height_texture", "frame_texture", "fresnelcolorwarp", "fresnelcolorwarptexture", "fresnelrangestexture", "fresnelwarp", "fresnelwarptexture", "fresnelwraptexure", "glint", "gradienttexture", "grain", "hdrbasetexture", "hdrcompressedtexture", "hdrcompressedtexture0", "hdrcompressedtexture1", "hdrcompressedtexture2", "internal_vignettetexture", "iridescentwarp", "iris", "lightluttexture", "lightwarptexture", "lightwraptexure", "maskmap1", "maskmap2", "noisetexture", "normal_texture", "normalmap", "normalmap2", "opacitytexture", "paintsplatenvmap", "paintsplatnormalmap", "phongexponenttexture", "phongwarptexture", "portalcolortexture", "portalmasktexture", "ramptexture", "reflecttexture", "reflecttinttexture", "refracttexture", "refracttinttexture", "screeneffecttexture", "selfillummask", "selfillumtexture", "shadowdepthtexture", "shadowtexture", "smallfb", "specmasktexture", "spectexture", "spectexture2", "spectexture3", "spectexture4", "specular_texture", "specularwarp", "ssao_texture", "staticblendtexture", "stretch", "texture1", "texture2", "texture3", "transmatmaskstexture", "underwateroverlay", "worldtotexture", "woundcutouttexture", "wrinkle", "ytexure" ]);

// VMT keys whose value is another material (materials/<value>.vmt)
const VMT_MATERIAL_KEYS = new Set(["bottommaterial","underwateroverlay","include","crackmaterial","overlaymaterial","fallbackmaterial","modelmaterial"]);

// VMF entity keys whose (extension-less) value is a material
const VMF_MATERIAL_KEYS = new Set(["material","texture","detailmaterial","ropematerial","smokematerial","overlaymaterial","overlayname","materialname",
  ...Array.from({ length: 10 }, (_, i) => "overlayname" + (i + 1))]);

// VMF entity keys whose value is a texture (vtf), e.g. env_projectedtexture
const VMF_TEXTURE_KEYS = new Set(["texturename","startexture"]);

// VMF entity keys whose value is a sound file or a soundscript name
const VMF_SOUND_KEYS = new Set(["message","noise1","noise2","startclosesound","closesound","locked_sound","unlocked_sound",
  "soundopenoverride","soundcloseoverride","soundmoveoverride","soundlockedoverride","soundunlockedoverride",
  "startsound","stopsound","movesound","includeclosesound","sound","soundname","sound1","sound2","sound3","sound4",
  "shootsound","explodesound","spawnsound","impactsound","breaksound","pushsound","ambientsound","soundscript",
  "locksound","unlocksound","opensound","closesound2","idlesound","runsound","attacksound","deathsound","painsound"]);

// VMF keys whose value is a generic file we must copy (relative to the game dir)
const VMF_FILE_KEYS = new Set(["vehiclescript","detailvbsp","filename","scenefile","scriptfile"]);

const SAFE = /^[a-z0-9_/.-]+$/; // valid material / model path (already lowercased)

module.exports = { VMT_TEXTURE_KEYS, VMT_MATERIAL_KEYS, VMF_MATERIAL_KEYS, VMF_TEXTURE_KEYS, VMF_SOUND_KEYS, VMF_FILE_KEYS, SAFE };
