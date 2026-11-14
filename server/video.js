export function parseVideo(input) {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Введите публичную ссылку VK Видео.');
  let url;
  const cleaned=input.trim().replace(/\\(?=[<:/])/g,'');
  const iframe=/^<iframe\s[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/iframe>$/i.exec(cleaned);
  try { url = new URL((iframe?iframe[1]:cleaned).replaceAll('&amp;','&')); } catch { throw new Error('Некорректная ссылка. Нужен адрес https://vkvideo.ru/video…'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !['vk.com','www.vk.com','m.vk.com','vk.ru','www.vk.ru','vkvideo.ru','www.vkvideo.ru'].includes(url.hostname)) throw new Error('Поддерживаются только HTTPS-ссылки vk.com, vk.ru и vkvideo.ru.');
  let owner, id;
  const match = /^\/video(-?\d+)_(\d+)\/?$/.exec(url.pathname) || /^video(-?\d+)_(\d+)(?:[/?].*)?$/.exec(url.searchParams.get('z') || '');
  if (match) [,owner,id] = match;
  else if (url.pathname === '/video_ext.php') { owner=url.searchParams.get('oid'); id=url.searchParams.get('id'); }
  if (!/^-?[1-9]\d{0,18}$/.test(owner || '') || !/^[1-9]\d{0,18}$/.test(id || '')) throw new Error('Не удалось найти видео в ссылке. Скопируйте адрес вида vkvideo.ru/video-123_456.');
  const embed = new URL('https://vk.com/video_ext.php');
  embed.searchParams.set('oid',owner); embed.searchParams.set('id',id); embed.searchParams.set('js_api','1');
  const hash=url.searchParams.get('hash');
  if(hash && /^[a-zA-Z0-9_-]{1,128}$/.test(hash)) embed.searchParams.set('hash',hash);
  return {id:`${owner}_${id}`,url:`https://vkvideo.ru/video${owner}_${id}`,embed:embed.href};
}
