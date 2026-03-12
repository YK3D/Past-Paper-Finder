export default async function handler(req, res) {
  const { url } = req.query;

  if (!url || !url.startsWith('https://pastpapers.papacambridge.com/')) {
    return res.status(400).json({ exists: false, error: 'Invalid URL' });
  }

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    // opaqueredirect (status 0, type opaqueredirect) = redirected to homepage = not found
    // 200 OK = file exists
    const exists = response.status === 200 || response.ok;
    return res.status(200).json({ exists });
  } catch (e) {
    return res.status(200).json({ exists: false, error: e.message });
  }
}
