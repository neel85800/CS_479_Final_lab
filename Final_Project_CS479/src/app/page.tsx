"use client";

import { useState } from "react";
import Link from "next/link";
import Map from "../map";


export default function Home() {
  const [data, setData] = useState<string>("");
  const [isConnected, setIsConnected] = useState(false);
  const [isTrailStarted, setIsTrailStarted] = useState(false);

  const connectToSerial = async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const port = await ((navigator as any) as any).serial.requestPort();
      await port.open({ baudRate: 115200 });

      setIsConnected(true);

      const decoder = new TextDecoderStream();
      const inputStream = port.readable?.pipeThrough(decoder);
      const reader = inputStream?.getReader();

      while (true) {
        const { value, done } = await reader?.read() || {};
        if (done) {
          console.log("Stream closed");
          reader?.releaseLock();
          break;
        }
        if (value) {
          setData((prevData) => prevData + value);
        }
      }
    } catch (error) {
      console.error("Error connecting to serial port:", error);
    }
  };

  const trackTrail = async () => { 
    setIsTrailStarted((prev) => !prev);
    // check for internet connection
    if (!navigator.onLine) {
      // alert("No internet connection. Using offline mode.");
      // handle offline mode (e.g., store data locally, check if trail is a predefined trail, etc.)

    }
    // arduino is constantly sending data, so we can just read it and send keep track of it
    // if we want to send it to a server, we can use fetch or websockets
    else{
      // focus online mode for now, using mapbox to display the trail/map
      // altitude will be used to determine the color of the trail (e.g., green for low altitude, red for high altitude) with a key to indicate the altitude range for each color
      // some things to keep track of during development:
      // - how to handle the data from the arduino (e.g., how to parse it, how to store it, etc.)
      // - how to display the data on the map (e.g., how to color the trail based on altitude, how to display other data such as speed, direction, etc.)
      // - gas sensor data can be used to determine if the trail is safe or not (e.g., if the gas levels are too high, we can display a warning on the map)
      // - keep track of time, speed, etc. to display on the map or in a sidebar
      // handle online mode (e.g., display map data)

      }
  };


  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex flex-1 w-full max-w-3xl flex-col items-center justify-between py-32 px-16 bg-white dark:bg-black sm:items-start">
        <h1 className="text-4xl font-bold text-center mb-8">
          CS 479 Final Project
        </h1>
        <button className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded" onClick={connectToSerial} disabled={isConnected}>
          {isConnected ? "Successfully Connected!" : "Click Here to Connect to Arduino"}
        </button>

        <button className="bg-green-500 hover:bg-green-700 text-white font-bold py-2 px-4 rounded" onClick={trackTrail} disabled={!isConnected}>
          {isTrailStarted ? "End Trail" : "Start Trail"}
        </button>
        <Link href="/online-map" className="bg-gray-700 hover:bg-gray-600 text-white font-bold py-2 px-4 rounded">
          Online Map
        </Link>
        <Link href="/offline-map" className="bg-gray-700 hover:bg-gray-600 text-white font-bold py-2 px-4 rounded">
          Offline Map
        </Link>
        <pre>{data}</pre>
        {isConnected && <Map />}
      </main>
    </div>
  );
}
