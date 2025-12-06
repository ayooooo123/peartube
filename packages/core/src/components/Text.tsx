import React from 'react';
import { Text as RNText, StyleSheet } from 'react-native';
import { TextProps, getTextStyles } from './styles';

export const Text: React.FC<TextProps> = (props) => {
  const { children, variant = 'body' } = props;
  const styles = getTextStyles(props);

  return (
    <RNText
      style={[
        textStyles.base,
        {
          color: styles.color,
          fontSize: styles.fontSize,
          fontWeight: styles.fontWeight,
        },
      ]}
    >
      {children}
    </RNText>
  );
};

const textStyles = StyleSheet.create({
  base: {},
});
