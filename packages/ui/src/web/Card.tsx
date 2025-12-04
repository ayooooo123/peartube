import React from 'react';
import { View, StyleSheet } from 'react-native';
import { CardProps, getCardStyles } from '../primitives';

export const Card: React.FC<CardProps> = ({ children }) => {
  const styles = getCardStyles();

  return (
    <View
      style={[
        cardStyles.base,
        {
          backgroundColor: styles.backgroundColor,
          borderRadius: styles.borderRadius,
          borderWidth: styles.borderWidth,
          borderColor: styles.borderColor,
          padding: styles.padding,
        },
      ]}
    >
      {children}
    </View>
  );
};

const cardStyles = StyleSheet.create({
  base: {
    overflow: 'hidden',
  },
});
