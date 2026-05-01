import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white font-mono flex items-center justify-center p-6">
      <section className="w-full max-w-md text-center">
        <h1 className="text-5xl font-bold mb-3">TrailBack</h1>
        <p className="text-sm text-gray-400 mb-8">Grp5 - Kirtan, Neel, Nundun, Jose</p>

        <div className="grid gap-3">
          <Link
            href="/online-map"
            className="border border-gray-700 hover:border-cyan-500 bg-zinc-950 px-5 py-4 rounded text-sm transition-colors"
          >
            Live Map
          </Link>
          <Link
            href="/offline-map"
            className="border border-gray-700 hover:border-cyan-500 bg-zinc-950 px-5 py-4 rounded text-sm transition-colors"
          >
            Local Canvas
          </Link>
        </div>
      </section>
    </main>
  );
}
