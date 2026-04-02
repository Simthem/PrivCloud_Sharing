const Logo = ({
  height,
  width,
  src = "/img/logo.webp",
}: {
  height: number;
  width: number;
  src?: string;
}) => {
  return (
    <img
      src={src}
      alt="logo"
      height={height}
      width={width}
      // eslint-disable-next-line react/no-unknown-property
      fetchPriority="high"
      decoding="async"
    />
  );
};
export default Logo;
