import BrandMark from "@/media/logo/anyhealth-mark.svg";

export default function BrandLockup({
  className = "",
  markClassName = "h-8 w-8",
  nameClassName = "text-xl",
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <img src={BrandMark} alt="" aria-hidden="true" className={markClassName} />
      <span className={`font-semibold tracking-tight ${nameClassName}`}>AnyHealth</span>
    </span>
  );
}
