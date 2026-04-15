const Logo = ({
  height,
  width,
  src = "/img/logo.webp",
  srcSet,
  alt = "PrivCloud Sharing logo",
}: {
  height: number;
  width: number;
  src?: string;
  srcSet?: string;
  alt?: string;
}) => {
  return (
    <img
      src={src}
      srcSet={srcSet}
      alt={alt}
      height={height}
      width={width}
      // eslint-disable-next-line react/no-unknown-property
      fetchPriority="high"
      decoding="async"
    />
  );
};
export default Logo;
