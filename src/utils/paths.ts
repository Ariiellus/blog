const splitPath = (value: string) => value.split('/').filter(Boolean);

export const relativePath = (fromPathname: string, targetPath: string) => {
  if (!targetPath.startsWith('/')) {
    return targetPath;
  }

  const fromSegments = splitPath(fromPathname);
  const targetSegments = splitPath(targetPath);

  let common = 0;
  while (
    common < fromSegments.length &&
    common < targetSegments.length &&
    fromSegments[common] === targetSegments[common]
  ) {
    common += 1;
  }

  const up = '../'.repeat(fromSegments.length - common);
  const down = targetSegments.slice(common).join('/');

  if (!up && !down) {
    return './';
  }

  const suffix = targetPath.endsWith('/') && down ? '/' : '';
  if (!up && down) {
    return `./${down}${suffix}`;
  }

  return `${up}${down}${suffix}` || './';
};
