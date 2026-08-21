// Three registered compositions = three aspect ratios off ONE component:
//   Square    1080x1080  (LinkedIn feed - the primary deliverable)
//   Vertical  1080x1920  (Reels / Stories)
//   Landscape 1920x1080  (YouTube / landscape embeds)
// Language is a prop (defaultProps: en), overridable per render with
//   --props='{"lang":"zh"}'  or  '{"lang":"fil"}'.
import React from "react";
import { Composition } from "remotion";
import { Main, FPS, TOTAL_FRAMES, type MainProps } from "./Main";

const defaultProps: MainProps = { lang: "en" };

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Square"
        component={Main}
        durationInFrames={TOTAL_FRAMES}
        fps={FPS}
        width={1080}
        height={1080}
        defaultProps={defaultProps}
      />
      <Composition
        id="Vertical"
        component={Main}
        durationInFrames={TOTAL_FRAMES}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={defaultProps}
      />
      <Composition
        id="Landscape"
        component={Main}
        durationInFrames={TOTAL_FRAMES}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={defaultProps}
      />
    </>
  );
};
