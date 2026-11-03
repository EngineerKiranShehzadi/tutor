export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  // The profile pages used to carry their own 240px dark sidebar, their own
  // indigo palette and their own copy of the navigation, which made them look
  // like a separate product and listed every destination twice. They now use
  // the same top bar as the rest of the app, so this layout only passes
  // children through.
  return <>{children}</>;
}
