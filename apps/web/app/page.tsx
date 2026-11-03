import { redirect } from "next/navigation";

/** The only public page worth landing on is the live proof of payments. */
export default function Home() {
  redirect("/proof");
}
