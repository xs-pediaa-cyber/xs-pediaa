const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const FormData = require('form-data');

const router = express.Router();

const BASE_URL = 'https://xs-pedia-payment.vercel.app';

// Background yang kamu gunakan
const DEFAULT_BG_URL = 'https://files.catbox.moe/r0jzqs.png';

/**
 * Download image menjadi Buffer
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
 * Gabungkan QRIS + Background
 */
async function createQrisComposite(qrisImageUrl) {
  const [bgBuffer, qrBuffer] = await Promise.all([
    downloadImage(DEFAULT_BG_URL),
    downloadImage(qrisImageUrl)
  ]);

  const bgMeta = await sharp(bgBuffer).metadata();

  const bgWidth = bgMeta.width || 1080;
  const bgHeight = bgMeta.height || 1080;

  // QR diperkecil menjadi 50% dari lebar background
  const qrWidth = Math.floor(bgWidth * 0.50);

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

  const finalQrWidth = qrMeta.width || qrWidth;
  const finalQrHeight = qrMeta.height || qrWidth;

  // QR di tengah background
  const left = Math.floor((bgWidth - finalQrWidth) / 2);
  const top = Math.floor((bgHeight - finalQrHeight) / 2);

  return await sharp(bgBuffer)
    .composite([
      {
        input: resizedQr,
        left,
        top
      }
    ])
    .png()
    .toBuffer();
}

/**
 * Upload ke Catbox
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

    /**
     * Request QRIS ke XS-Pedia
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

    if (!rawQrImage) {
      return res.status(502).json({
        success: false,
        message: 'XS-Pedia tidak mengembalikan image_url.'
      });
    }

    /**
     * Gabungkan QR + Background
     */
    let combinedImage;

    try {
      const compositeBuffer = await createQrisComposite(rawQrImage);

      combinedImage = await uploadToCatbox(compositeBuffer);

    } catch (error) {
      console.error('QRIS Composite Error:', error.message);

      return res.status(502).json({
        success: false,
        message: 'Gagal menggabungkan QRIS dengan background.'
      });
    }

    /**
     * RESPONSE HANYA HASIL GABUNGAN
     *
     * Tidak lagi mengirim:
     * - image_url_raw
     * - background_url
     */
    return res.status(200).json({
      success: true,
      image_url: combinedImage,
      image_url_combined: combinedImage,
      amount: result.amount,
      qr_string: result.qr_string,
      created_at: result.created_at
    });

  } catch (error) {
    console.error('XS-Pedia Create QRIS Error:', error.message);

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
router.desc = 'Membuat QRIS dengan background.';
router.status = 'ready';
router.type = 'free';

router.paramsConfig = {
  amount: '100',
  static_qr: '000201010211....'
};

module.exports = router;
