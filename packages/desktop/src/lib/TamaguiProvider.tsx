/**
 * Theme Provider
 * Simple React context for theme access
 */

import React, { createContext, useContext } from 'react';
import { theme, Theme } from './theme';

const ThemeContext = createContext<Theme>(theme);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

interface Props {
  children: React.ReactNode;
}

export function TamaguiProvider({ children }: Props) {
  return (
    <ThemeContext.Provider value={theme}>
      {children}
    </ThemeContext.Provider>
  );
}
