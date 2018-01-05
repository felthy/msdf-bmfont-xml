const utils = require('./lib/utils');
const opentype = require('opentype.js');
const exec = require('child_process').exec;
const mapLimit = require('map-limit');
const MaxRectsPacker = require('maxrects-packer');
const Canvas = require('canvas-prebuilt');
const path = require('path');
const ProgressBar = require('cli-progress');
const fs = require('fs');

const defaultCharset = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~".split('');
const controlChars = ['\n', '\r', '\t'];

const binaryLookup = {
  darwin: 'msdfgen.osx',
  win32: 'msdfgen.exe',
  linux: 'msdfgen.linux'
};

module.exports = generateBMFont;

/**
 * Creates a BMFont compatible bitmap font of signed distance fields from a font file
 *
 * @param {string} fontPath - Path to the input ttf/otf/woff font 
 * @param {Object} opt - Options object for generating bitmap font (Optional) :
 *            outputType : font file format Avaliable: xml(default), json
 *            filename : filename of both font file and font textures
 *            fontSize : font size for generated textures (default 42)
 *            charset : charset in generated font, could be array or string (default is Western)
 *            textureWidth : Width of generated textures (default 512)
 *            textureHeight : Height of generated textures (default 512)
 *            distanceRange : distance range for computing signed distance field
 *            fieldType : "msdf"(default), "sdf", "psdf"
 *            roundDecimal  : rounded digits of the output font file. (Defaut is null)
 *            smartSize : shrink atlas to the smallest possible square (Default: false)
 *            pot : atlas size shall be power of 2 (Default: false)
 *            square : atlas size shall be square (Default: false)
 * @param {function(string, Array.<Object>, Object)} callback - Callback funtion(err, textures, font) 
 *
 */
function generateBMFont (fontPath, opt, callback) {
  const binName = binaryLookup[process.platform];
  if (binName === undefined) {
    throw new Error(`No msdfgen binary for platform ${process.platform}.`);
  }
  const binaryPath = path.join(__dirname, 'bin', binName);

  if (!fontPath || typeof fontPath !== 'string') {
    throw new TypeError('must specify a font path');
  }
  let fontDir = path.dirname(fontPath); // Set fallback output path to font path
  if (typeof opt === 'function') {
    callback = opt;
    opt = {};
  }
  if (callback && typeof callback !== 'function') {
    throw new TypeError('expected callback to be a function');
  }
  if (!callback) {
    throw new TypeError('missing callback');
  }
  if (typeof opt.reuse !== 'undefined' && typeof opt.reuse !== 'boolean') {
    // if (path.dirname(opt.reuse).length > 0) {
    //   fontDir = path.dirname(opt.reuse);
    // }
    if (!fs.existsSync(opt.reuse)) {
      console.log('Creating cfg file :' + opt.reuse);
      opt.reuse.opt = {};
    } else {
      console.log('Loading cfg file :' + opt.reuse);
      opt.reuse = JSON.parse(fs.readFileSync(opt.reuse, 'utf8'));
    }
  }
  if (opt.textureSize && opt.textureSize.length !== 2) {
    console.error('textureSize format shall be: width,height');
    process.exit(1);
  }

  callback = callback || function () {};
  opt = opt || {};
  const reuse = typeof opt.reuse === 'boolean' ? {} : opt.reuse.opt;
  let charset = opt.charset = (typeof opt.charset === 'string' ? opt.charset.split('') : opt.charset) || reuse.charset || defaultCharset;
  const outputType = opt.outputType = utils.valueQueue([opt.outputType, reuse.outputType, "xml"]);
  let filename = utils.valueQueue([opt.filename, reuse.filename]);
  const fontSize = opt.fontSize = utils.valueQueue([opt.fontSize, reuse.fontSize, 42]);
  const fontSpacing = opt.fontSpacing = utils.valueQueue([opt.fontSpacing, reuse.fontSpacing, [0, 0]]);
  const fontPadding = opt.fontPadding = utils.valueQueue([opt.fontPadding, reuse.fontPadding, [0, 0, 0, 0]]);
  const textureWidth = opt.textureWidth = utils.valueQueue([opt.textureSize || reuse.textureSize, [512, 512]])[0];
  const textureHeight = opt.textureHeight = utils.valueQueue([opt.textureSize || reuse.textureSize, [512, 512]])[1];
  const texturePadding = opt.texturePadding = utils.valueQueue([opt.texturePadding, reuse.texturePadding, 1]);
  const distanceRange = opt.distanceRange = utils.valueQueue([opt.distanceRange, reuse.distanceRange, 4]);
  const fieldType = opt.fieldType = utils.valueQueue([opt.fieldType, reuse.fieldType, 'msdf']);
  const roundDecimal = opt.roundDecimal = utils.valueQueue([opt.roundDecimal, reuse.roundDecimal]); // if no roudDecimal option, left null as-is
  const smartSize = opt.smartSize = utils.valueQueue([opt.smartSize, reuse.smartSize, false]);
  const pot = opt.pot = utils.valueQueue([opt.pot, reuse.pot, false]);
  const square = opt.square = utils.valueQueue([opt.square, reuse.square, false]);
  const debug = opt.vector || false;
  const tolerance = opt.tolerance = utils.valueQueue([opt.tolerance, reuse.tolerance, 0]);
  // const cfg = typeof opt.reuse === 'boolean' ? opt.reuse : false;

  // TODO: Validate options
  if (fieldType !== 'msdf' && fieldType !== 'sdf' && fieldType !== 'psdf') {
    throw new TypeError('fieldType must be one of msdf, sdf, or psdf');
  }

  const font = opentype.loadSync(fontPath);
  if (font.outlinesFormat !== 'truetype' && font.outlinesFormat !== 'cff') {
    throw new TypeError('must specify a truetype font (ttf, otf, woff)');
  }
  const packer = new MaxRectsPacker(textureWidth, textureHeight, texturePadding, {
    smart: smartSize,
    pot: pot,
    square: square 
  });
  const chars = [];
  
  charset = charset.filter((e, i, self) => {
    return (i == self.indexOf(e)) && (!controlChars.includes(e));
  }); // Remove duplicate & control chars

  const os2 = font.tables.os2;
  const baseline = os2.sTypoAscender * (fontSize / font.unitsPerEm) + (distanceRange >> 1);
  const fontface = path.basename(fontPath, path.extname(fontPath));
  if(!filename) {
    filename = fontface;
    console.log(`Use font-face as filename : ${filename}`);
  } else {
    if (opt.filename) fontDir = path.dirname(opt.filename);
    filename = opt.filename = path.basename(filename, path.extname(filename));
  }

  // Initialize settings
  let settings = {};
  settings.opt = JSON.parse(JSON.stringify(opt));
  delete settings.opt['reuse']; // prune previous settings
  let pages = [];
  if (opt.reuse.packer !== undefined) {
    pages = opt.reuse.pages;
    packer.load(opt.reuse.packer.bins);
  }

  let bar;
  bar = new ProgressBar.Bar({
    format: "Generating {percentage}%|{bar}| ({value}/{total}) {duration}s",
    clearOnComplete: true
  }, ProgressBar.Presets.shades_classic); 
  bar.start(charset.length, 0);

  mapLimit(charset, 15, (char, cb) => {
    generateImage({
      binaryPath,
      font,
      char,
      fontSize,
      fieldType,
      distanceRange,
      roundDecimal,
      debug,
      tolerance
    }, (err, res) => {
      if (err) return cb(err);
      bar.increment();
      cb(null, res);
    });
  }, (err, results) => {
    if (err) callback(err);
    bar.stop();

    packer.addArray(results);
    const textures = packer.bins.map((bin, index) => {
      let svg = "";
      let texname = "";
      const canvas = new Canvas(bin.width, bin.height);
      const context = canvas.getContext('2d');
      if(fieldType === "msdf") {
        context.fillStyle = '#000000';
        context.fillRect(0, 0, canvas.width, canvas.height);
      } else {
        context.clearRect(0, 0, canvas.width, canvas.height);
      }
      if (index > pages.length - 1) { 
        if (packer.bins.length > 1) texname = `${filename}.${index}`;
        else texname = filename; 
        pages.push(`${texname}.png`);
      } else {
        texname = path.basename(pages[index], path.extname(pages[index]));
        let img = new Canvas.Image;
        img.src = fs.readFileSync(path.join(fontDir, `${texname}.png`));
        context.drawImage(img, 0, 0);
      }
      bin.rects.forEach(rect => {
        if (rect.data.imageData) {
          context.putImageData(rect.data.imageData, rect.x, rect.y);
          if (debug) {
            const x_woffset = rect.x - rect.data.fontData.xoffset + (distanceRange >> 1);
            const y_woffset = rect.y - rect.data.fontData.yoffset + baseline + (distanceRange >> 1);
            svg += font.charToGlyph(rect.data.fontData.char).getPath(x_woffset, y_woffset, fontSize).toSVG() + "\n";
          }
        }
        const charData = rect.data.fontData;
        charData.x = rect.x;
        charData.y = rect.y;
        charData.page = index;
        chars.push(rect.data.fontData);
      });
      let tex = {
        filename: path.join(fontDir, texname),
        texture: canvas.toBuffer()
      }
      if (debug) tex.svg = svg;
      return tex;
    });
    const kernings = [];
    charset.forEach(first => {
      charset.forEach(second => {
        const amount = font.getKerningValue(font.charToGlyph(first), font.charToGlyph(second));
        if (amount !== 0) {
          kernings.push({
            first: first.charCodeAt(0),
            second: second.charCodeAt(0),
            amount: amount * (fontSize / font.unitsPerEm)
          });
        }
      });
    });

    const fontData = {
      pages,
      chars,
      info: {
        face: fontface,
        size: fontSize,
        bold: 0,
        italic: 0,
        charset,
        unicode: 1,
        stretchH: 100,
        smooth: 1,
        aa: 1,
        padding: fontPadding,
        spacing: fontSpacing
      },
      common: {
        lineHeight: (os2.sTypoAscender - os2.sTypoDescender + os2.sTypoLineGap) * (fontSize / font.unitsPerEm),
        base: baseline,
        scaleW: packer.bins[0].width,
        scaleH: packer.bins[0].height,
        pages: packer.bins.length,
        packed: 0,
        alphaChnl: 0,
        redChnl: 0,
        greenChnl: 0,
        blueChnl: 0
      },
      distanceField: {
        fieldType: fieldType,
        distanceRange: distanceRange
      },
      kernings: kernings
    };
    if(roundDecimal !== null) utils.roundAllValue(fontData, roundDecimal);
    let fontFile = {};
    const ext = outputType === "json" ? `.json` : `.fnt`;
    fontFile.filename = path.join(fontDir, fontface + ext);
    fontFile.data = utils.stringify(fontData, outputType);

    // Store pages name and available packer freeRects in settings
    settings.pages = pages;
    settings.packer = {};
    settings.packer.bins = packer.save(); 
    fontFile.settings = settings;

    console.log("\nGeneration complete!\n");
    callback(null, textures, fontFile);
  });
}

function generateImage (opt, callback) {
  const {binaryPath, font, char, fontSize, fieldType, distanceRange, roundDecimal, debug, tolerance} = opt;
  const glyph = font.charToGlyph(char);
  const commands = glyph.getPath(0, 0, fontSize).commands;
  let contours = [];
  let currentContour = [];
  const bBox = glyph.getPath(0, 0, fontSize).getBoundingBox();
  commands.forEach(command => {
    if (command.type === 'M') { // new contour
      if (currentContour.length > 0) {
        contours.push(currentContour);
        currentContour = [];
      }
    }
    currentContour.push(command);
  });
  contours.push(currentContour);

  if (tolerance != 0) {
    utils.setTolerance(tolerance, tolerance * 10);
    let numFiltered = utils.filterContours(contours);
    if (numFiltered && debug)
      console.log(`\n${char} removed ${numFiltered} small contour(s)`);
    // let numReversed = utils.alignClockwise(contours, false);
    // if (numReversed && debug)
    //   console.log(`${char} found ${numReversed}/${contours.length} reversed contour(s)`);
  }
  let shapeDesc = utils.stringifyContours(contours);

  if (contours.some(cont => cont.length === 1)) console.log('length is 1, failed to normalize glyph');
  const scale = fontSize / font.unitsPerEm;
  const baseline = font.tables.os2.sTypoAscender * (fontSize / font.unitsPerEm);
  const pad = distanceRange >> 1;
  let width = Math.round(bBox.x2 - bBox.x1) + pad + pad;
  let height = Math.round(bBox.y2 - bBox.y1) + pad + pad;
  let xOffset = Math.round(-bBox.x1) + pad;
  let yOffset = Math.round(-bBox.y1) + pad;
  if (roundDecimal != null) {
    xOffset = utils.roundNumber(xOffset, roundDecimal);
    yOffset = utils.roundNumber(yOffset, roundDecimal);
  }
  let command = `${binaryPath} ${fieldType} -format text -stdout -size ${width} ${height} -translate ${xOffset} ${yOffset} -pxrange ${distanceRange} -defineshape "${shapeDesc}"`;

  exec(command, (err, stdout, stderr) => {
    if (err) return callback(err);
    const rawImageData = stdout.match(/([0-9a-fA-F]+)/g).map(str => parseInt(str, 16)); // split on every number, parse from hex
    const pixels = [];
    const channelCount = rawImageData.length / width / height;

    if (!isNaN(channelCount) && channelCount % 1 !== 0) {
      console.error(command);
      console.error(stdout);
      return callback(new RangeError('msdfgen returned an image with an invalid length'));
    }
    if (fieldType === 'msdf') {
      for (let i = 0; i < rawImageData.length; i += channelCount) {
        pixels.push(...rawImageData.slice(i, i + channelCount), 255); // add 255 as alpha every 3 elements
      }
    } else {
      for (let i = 0; i < rawImageData.length; i += channelCount) {
        pixels.push(rawImageData[i], rawImageData[i], rawImageData[i], rawImageData[i]); // make monochrome w/ alpha
      }
    }
    let imageData;
    if (isNaN(channelCount) || !rawImageData.some(x => x !== 0)) { // if character is blank
      // console.warn(`no bitmap for character '${char}' (${char.charCodeAt(0)}), adding to font as empty`);
      // console.warn(command);
      // console.warn('---');
      width = 0;
      height = 0;
    } else {
      imageData = new Canvas.ImageData(new Uint8ClampedArray(pixels), width, height);
    }
    const container = {
      data: {
        imageData,
        fontData: {
          id: char.charCodeAt(0),
          index: glyph.index,
          char: char,
          width: width,
          height: height,
          xoffset: Math.round(bBox.x1) - pad,
          yoffset: Math.round(bBox.y1) + pad + baseline,
          xadvance: glyph.advanceWidth * scale,
          chnl: 15
        }
      },
      width: width,
      height: height
    };
    callback(null, container);
  });
}

