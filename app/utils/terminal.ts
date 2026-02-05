const reset = '\x1b[0m';

export const escapeCodes = {
  reset,
  clear: '\x1b[g',
  red: '\x1b[1;31m',
  cyan: '\x1b[1;36m',
  gray: '\x1b[0;90m',
  green: '\x1b[1;32m',
  yellow: '\x1b[1;33m',
};

export const coloredText = {
  red: (text: string) => `${escapeCodes.red}${text}${reset}`,
  cyan: (text: string) => `${escapeCodes.cyan}${text}${reset}`,
  gray: (text: string) => `${escapeCodes.gray}${text}${reset}`,
  green: (text: string) => `${escapeCodes.green}${text}${reset}`,
  yellow: (text: string) => `${escapeCodes.yellow}${text}${reset}`,
};
