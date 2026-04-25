import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function GET() {
  const filePath = path.join(process.cwd(), "Waterfall_Glen_Trail.csv");
  const content = fs.readFileSync(filePath, "utf-8");

  const lines = content.trim().split("\n");
  const points = lines.slice(1).map((line) => {
    const [lat, lng, elevation] = line.split(",");
    return {
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      elevation: parseFloat(elevation),
    };
  });

  return NextResponse.json(points);
}
