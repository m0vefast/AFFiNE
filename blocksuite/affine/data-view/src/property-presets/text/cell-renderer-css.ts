import { css } from '@emotion/css';
import { baseTheme } from '@toeverything/theme';

export const textStyle = css({
  display: 'flex',
  alignItems: 'center',
  height: '100%',
  width: '100%',
  padding: '0',
  border: 'none',
  fontFamily: baseTheme.fontSansFamily,
  fontSize: 'var(--affine-font-base)',
  lineHeight: 'var(--affine-line-height)',
  color: 'var(--affine-text-primary-color)',
  fontWeight: '400',
  backgroundColor: 'transparent',
  whiteSpace: 'normal',
  wordBreak: 'break-word',
});

export const textInputStyle = css({
  display: 'flex',
  alignItems: 'center',
  height: '100%',
  width: '100%',
  padding: '0',
  border: 'none',
  fontFamily: baseTheme.fontSansFamily,
  fontSize: 'var(--affine-font-base)',
  lineHeight: 'var(--affine-line-height)',
  color: 'var(--affine-text-primary-color)',
  fontWeight: '400',
  backgroundColor: 'transparent',
  cursor: 'text',
  whiteSpace: 'normal',
  wordBreak: 'break-word',
  ':focus': {
    outline: 'none',
  },
});
