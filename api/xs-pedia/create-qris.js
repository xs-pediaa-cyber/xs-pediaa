const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const FormData = require('form-data');

const router = express.Router();

const BASE_URL = 'https://xs-pedia-payment.vercel.app';

// GANTI dengan URL background kamu
const DEFAULT_BG_URL = 'https://website-kamu.com/background.png';

/**
 * Download gambar dari URL menjadi Buffer
 */
async function downloadImage(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'image/*'
    }
  });

  return Buffer.from(response.data);
}

/**
 * Gabungkan QRIS dengan background
 */
async function createQrisComposite(qrisImageUrl) {
  const [bgBuffer, qrBuffer] = await Promise.all([
    downloadImage(DEFAULT_BG_URL),
    downloadImage(qrisImageUrl)
  ]);

  // Ambil ukuran background
  const bgMeta = await sharp(bgBuffer).metadata();

  const bgWidth = bgMeta.width || 1080;
  const bgHeight = bgMeta.height || 1080;

  /*
   * Ukuran QR:
   * 65% dari lebar background
   * sehingga QR tetap jelas dan berada di tengah
   */
  const qrWidth = Math.floor(bgWidth * 0.65);

  const resizedQr = await sharp(qrBuffer)
    .resize({
      width: qrWidth,
      height: qrWidth,
      fit: 'contain',
      background: {
        r: 255,
        g: 255,
        b: 255,
        alpha: 1
      }
    })
    .png()
    .toBuffer();

  const qrMeta = await sharp(resizedQr).metadata();

  const qrFinalWidth = qrMeta.width || qrWidth;
  const qrFinalHeight = qrMeta.height || qrWidth;

  /*
   * Posisi QR di tengah background
   */
  const left = Math.floor((bgWidth - qrFinalWidth) / 2);
  const top = Math.floor((bgHeight - qrFinalHeight) / 2);

  const result = await sharp(bgBuffer)
    .composite([
      {
        input: resizedQr,
        left,
        top
      }
    ])
    .png()
    .toBuffer();

  return result;
}

/**
 * Upload hasil composite ke Catbox
 */
async function uploadToCatbox(buffer) {
  const form = new FormData();

  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', buffer, {
    filename: `qris-${Date.now()}.png`,
    contentType: 'image/png'
  });

  const response = await axios.post(
    'https://catbox.moe/user/api.php',
    form,
    {
      headers: {
        ...form.getHeaders(),
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 60000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    }
  );

  const url = String(response.data || '').trim();

  if (!url.startsWith('http')) {
    throw new Error(`Upload Catbox gagal: ${url}`);
  }

  return url;
}

router.get('/', async (req, res) => {
  try {
    const amount = String(req.query.amount || '').trim();
    const static_qr = String(req.query.static_qr || '').trim();

    if (!amount || !static_qr) {
      return res.status(400).json({
        success: false,
        message: 'Parameter amount dan static_qr wajib diisi.'
      });
    }

    if (!DEFAULT_BG_URL) {
      return res.status(500).json({
        success: false,
        message: 'Background belum disetting.'
      });
    }

    /**
     * ==========================================
     * 1. REQUEST KE XS-PEDIA
     * ==========================================
     */
    const response = await axios.get(
      `${BASE_URL}/api/qris/create`,
      {
        params: {
          amount,
          static_qr
        },
        timeout: 30000,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0'
        }
      }
    );

    const result = response.data;

    if (!result?.success) {
      return res.status(response.status || 502).json(result);
    }

    const rawQrImage = result.image_url || '';
    const qrisString = result.qr_string || '';

    if (!rawQrImage) {
      return res.status(502).json({
        success: false,
        message: 'XS-Pedia tidak mengembalikan image_url.'
      });
    }

    /**
     * ==========================================
     * 2. GABUNGKAN QR + BACKGROUND
     * ==========================================
     */
    let compositeUrl = rawQrImage;

    try {
      const compositeBuffer = await createQrisComposite(rawQrImage);

      /**
       * ========================================
       * 3. UPLOAD HASIL KE CATBOX
       * ========================================
       */
      compositeUrl = await uploadToCatbox(compositeBuffer);

    } catch (error) {
      console.error(
        'QRIS Composite / Upload Error:',
        error.message
      );

      /**
       * Kalau composite gagal, jangan bikin endpoint
       * mati total. Tetap kembalikan QR asli.
       */
      compositeUrl = rawQrImage;
    }

    /**
     * ==========================================
     * 4. RESPONSE
     * ==========================================
     *
     * image_url       = hasil QR + background
     * image_url_raw   = QR asli XS-Pedia
     */
    return res.status(response.status || 200).json({
      ...result,

      image_url: compositeUrl,
      image_url_combined: compositeUrl,
      image_url_raw: rawQrImage,

      qr_string: qrisString,

      background_url: DEFAULT_BG_URL
    });

  } catch (error) {
    console.error(
      'XS-Pedia Create QRIS Error:',
      error.message
    );

    const status = error.response?.status || 500;

    return res.status(status).json(
      error.response?.data || {
        success: false,
        message: error.message
      }
    );
  }
});

router.title = 'XS Pedia - Create QRIS';
router.name = 'XS Pedia - Create QRIS';
router.desc = 'Membuat QRIS dinamis dengan background.';
router.status = 'ready';
router.type = 'free';
router.paramsConfig = {
  amount: '100',
  static_qr: '000201010211....'
};

module.exports = router;
