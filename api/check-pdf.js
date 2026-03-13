export default async function handler(req, res) {
  const { url } = req.query;

  if (!url || !url.startsWith('https://pastpapers.papacambridge.com/')) {
    return res.status(400).json({ exists: false, error: 'Invalid URL' });
  }

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    // A real PDF returns content-type: application/pdf
    // A soft-404 redirect to homepage returns text/html with status 200
    // So checking content-type is more reliable than status alone
    const contentType = response.headers.get('content-type') || '';
    const exists = response.ok && contentType.includes('application/pdf');

    return res.status(200).json({ exists });
  } catch (e) {
    return res.status(200).json({ exists: false, error: e.message });
  }
}
