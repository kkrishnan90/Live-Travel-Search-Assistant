/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { type FunctionDeclaration, SchemaType } from "@google/generative-ai";
import { useEffect, memo, useState, useRef, useCallback } from "react";
import './altair.scss';
import { useLiveAPIContext } from "../../contexts/LiveAPIContext";
import { ToolCall } from "../../multimodal-live-types";
import { VariableSizeList as List } from 'react-window';

// Function to safely parse the tool definition from environment variable
const getSearchToolDefinition = (): FunctionDeclaration | null => {
  const definitionString = process.env.REACT_APP_SEARCH_HOTEL_TOOL_DEFINITION;
  if (!definitionString) {
    console.error("REACT_APP_SEARCH_HOTEL_TOOL_DEFINITION is not set in .env");
    return null;
  }
  try {
    const parsed = JSON.parse(definitionString);
    // Manually map string types back to SchemaType enums
    const mapSchemaType = (typeString: string): SchemaType => {
        switch (typeString) {
            case "OBJECT": return SchemaType.OBJECT;
            case "STRING": return SchemaType.STRING;
            // Add other types as needed
            default: throw new Error(`Unsupported SchemaType string: ${typeString}`);
        }
    };

    return {
        ...parsed,
        parameters: {
            ...parsed.parameters,
            type: mapSchemaType(parsed.parameters.type),
            properties: {
                ...parsed.parameters.properties,
                query: {
                    ...parsed.parameters.properties.query,
                    type: mapSchemaType(parsed.parameters.properties.query.type),
                }
            }
        }
    } as FunctionDeclaration; // Assert type after mapping
  } catch (error) {
    console.error("Failed to parse REACT_APP_SEARCH_HOTEL_TOOL_DEFINITION:", error);
    return null;
  }
};

function AltairComponent() {
  const { client, setConfig } = useLiveAPIContext();
  const [hotelResults, setHotelResults] = useState<any[] | null>(null);
  const [searchToolDefinition, setSearchToolDefinition] = useState<FunctionDeclaration | null>(null);
  const [toolConfigError, setToolConfigError] = useState<string | null>(null);

  // Refs for VariableSizeList
  const listRef = useRef<List>(null);
  const itemHeightsRef = useRef<{[key: number]: number}>({});
  const measurementClientRef = useRef<HTMLDivElement>(null);
// Refs for asynchronous measurement
  const measurementRequestRef = useRef<number | null>(null);
  const itemsToMeasureRef = useRef<any[]>([]);
  const measuredHeightsRef = useRef<{[key: number]: number}>({});
  const currentMeasureIndexRef = useRef<number>(0);

  // Log if client instance changes
  const clientInstanceRef = useRef(client);
  useEffect(() => {
    if (clientInstanceRef.current !== client) {
      console.warn('AltairComponent: client instance from context has CHANGED!');
      clientInstanceRef.current = client;
    } else {
      // console.log('AltairComponent: client instance from context is STABLE.'); // Optional: too noisy usually
    }
  }, [client]);

  // Load and configure the Live API client with the Discovery Engine tool from .env
  useEffect(() => {
    const definition = getSearchToolDefinition();
    const toolUrl = process.env.REACT_APP_SEARCH_HOTEL_TOOL_URL;

    if (!definition) {
        setToolConfigError("Search tool definition is missing or invalid in .env.");
        return;
    }
    if (!toolUrl) {
        setToolConfigError("Search tool URL (REACT_APP_SEARCH_HOTEL_TOOL_URL) is missing in .env.");
        return;
    }
    setSearchToolDefinition(definition); // Store definition for later use in tool call handler
    setToolConfigError(null); // Clear any previous error

    // Safely parse generation config from env, providing a default if missing/invalid
    let generationConfig = {};
    try {
      generationConfig = JSON.parse(process.env.REACT_APP_GENERATION_CONFIG || '{}');
    } catch (error) {
      console.error("Failed to parse REACT_APP_GENERATION_CONFIG:", error, "Using default empty config.");
      setToolConfigError((prev) => (prev ? prev + "\n" : "") + "Invalid Generation Config in .env.");
    }

    // Read model name and system instructions from env, providing defaults
    const modelName = process.env.REACT_APP_MODEL_NAME || "models/gemini-2.0-flash-exp"; // Default model
    const systemInstructionsText = process.env.REACT_APP_SYSTEM_INSTRUCTIONS || 'You are a helpful travel assistant.'; // Default instructions

    if (!process.env.REACT_APP_MODEL_NAME) {
        console.warn("REACT_APP_MODEL_NAME not set in .env, using default.");
        setToolConfigError((prev) => (prev ? prev + "\n" : "") + "Model Name not set in .env.");
    }
    if (!process.env.REACT_APP_SYSTEM_INSTRUCTIONS) {
        console.warn("REACT_APP_SYSTEM_INSTRUCTIONS not set in .env, using default.");
        setToolConfigError((prev) => (prev ? prev + "\n" : "") + "System Instructions not set in .env.");
    }


    setConfig({
      model: modelName,
      generationConfig: generationConfig,
      systemInstruction: {
        parts: [
          {
            text: systemInstructionsText,
          },
        ],
      },
      tools: [
        // Include the Discovery Engine function declaration
        { functionDeclarations: [definition] }, // Use definition from env
        // You can include other tools like Google Search if needed
        { googleSearch: {} },
      ],
    });
  }, [setConfig]);

  // Handle incoming tool calls from Gemini
  useEffect(() => {
    const onToolCall = async (toolCall: ToolCall) => {
      console.log('AltairComponent: onToolCall invoked. Timestamp:', Date.now(), 'ToolCall:', JSON.stringify(toolCall));
      console.log(`Received tool call:`, toolCall); // Existing log, kept for comparison

      // Find the specific function call for Discovery Engine search
      const call = toolCall.functionCalls.find(
        (fc) => fc.name === searchToolDefinition?.name, // Use definition from state
      );

      // Ensure definition is loaded before processing tool call
      if (call && searchToolDefinition) {
        console.log(`Executing function call: ${call.name}`);
        const { query } = call.args as { query: string };

        // Retrieve the access token from environment variables
        const accessToken = process.env.REACT_APP_DISCOVERY_ENGINE_ACCESS_TOKEN;
        const placeholderToken = "YOUR_ACCESS_TOKEN_HERE"; // Define the placeholder

        // --- Error Handling: Check for missing or placeholder token ---
        if (!accessToken || accessToken === placeholderToken) {
          console.error(
            "Discovery Engine Access Token is missing or invalid in .env file.",
          );
          const errorResponse = {
            error: "Configuration Error",
            message:
              "Discovery Engine Access Token is missing or is still the placeholder value. Please update the .env file.",
          };
          client.sendToolResponse({ functionResponses: [{ id: call.id, response: errorResponse }] });
          return; // Stop execution if token is invalid
        }

        // Construct the API request body
        const requestBody = {
          query: query,
          pageSize: 5, // Adjust as needed
          queryExpansionSpec: {
            condition: "AUTO",
          },
          spellCorrectionSpec: {
            mode: "AUTO",
          },
          contentSearchSpec: {
            snippetSpec: {
              returnSnippet: true,
            },
            summarySpec: {
              summaryResultCount: 5,
              includeCitations: true,
            },
            extractiveContentSpec: {
              maxExtractiveAnswerCount: 1,
            },
          },
        };

        const apiUrl = process.env.REACT_APP_SEARCH_HOTEL_TOOL_URL;

        // --- Error Handling: Check for missing URL (already checked in config effect, but double-check) ---
        if (!apiUrl) {
            console.error("REACT_APP_SEARCH_HOTEL_TOOL_URL is missing in .env.");
            const errorResponse = {
                error: "Configuration Error",
                message: "Search tool URL is missing. Please check the .env file.",
            };
            client.sendToolResponse({ functionResponses: [{ id: call.id, response: errorResponse }] });
            return; // Stop execution if URL is missing
        }

        try {
          // --- Make the API call ---
          const response = await fetch(apiUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
          });

          // --- Handle API Response ---
          if (!response.ok) {
            // Attempt to parse error details from the API response
            let errorDetails = `API returned status: ${response.status}`;
            try {
              const errorData = await response.json();
              errorDetails += ` - ${JSON.stringify(errorData)}`;
            } catch (parseError) {
              errorDetails += " - Failed to parse error response body.";
            }
            console.error("Discovery Engine API call failed:", errorDetails);
            client.sendToolResponse({ functionResponses: [{ id: call.id, response: { error: "API Call Failed", details: errorDetails } }] });
          } else {
            // --- Success: Send results back to Gemini ---
            const results = await response.json();
            console.log('API Results Received:', JSON.stringify(results, null, 2)); // Added log 1
            console.log("Discovery Engine API call successful, sending results:", results);

            // Update state with hotel results before sending response
            // Added log 2
            setHotelResults(results?.results || []); // Directly use results.results, fallback to empty array
            console.log('Attempting to set hotelResults state with:', JSON.stringify(results?.results, null, 2)); // Log after setting state

            // Send the successful results back, wrapped correctly
            client.sendToolResponse({ functionResponses: [{ id: call.id, response: { output: results } }] });
          }
        } catch (error) {
          // --- Handle Network/Fetch Errors ---
          console.error("Error during Discovery Engine API call:", error);
          client.sendToolResponse({ functionResponses: [{ id: call.id, response: { error: "Network or Fetch Error", message: error instanceof Error ? error.message : String(error) } }] });
        }
      } else {
        // Handle cases where the tool call is not for search_discovery_engine
        // (e.g., if other tools were also called)
        console.warn("Received tool call for an unhandled function:", toolCall);
        // Optionally send a generic response or error for unhandled calls
      }
    };

    client.on("toolcall", onToolCall);
    return () => {
      client.off("toolcall", onToolCall);
    };
  }, [client, setConfig, searchToolDefinition]); // Add searchToolDefinition dependency

  // Effect to measure item heights asynchronously when hotelResults change
  useEffect(() => {
    // Cancel any ongoing measurement if hotelResults change or component unmounts
    if (measurementRequestRef.current) {
      cancelAnimationFrame(measurementRequestRef.current);
      measurementRequestRef.current = null;
    }

    if (hotelResults && measurementClientRef.current) {
      console.log("Measurement Scheduler: New hotelResults detected. Scheduling measurements.");
      itemsToMeasureRef.current = [...hotelResults]; // Copy to avoid issues if hotelResults changes during async processing
      measuredHeightsRef.current = {}; // Reset for new results
      currentMeasureIndexRef.current = 0;
      
      // Clear old heights immediately. This will cause the list to use default heights initially.
      // This is a trade-off: avoids showing stale (potentially wrong) heights from a previous dataset,
      // but might cause a flicker as items resize from default to measured height.
      itemHeightsRef.current = {};
      if (listRef.current) {
        listRef.current.resetAfterIndex(0, false); // Reset with default heights
      }

      const measurementNode = measurementClientRef.current;
      const CHUNK_SIZE = 5; // Number of items to measure per animation frame
      const MAX_TIME_PER_CHUNK_MS = 4; // Max time (ms) to spend on measurements per frame to stay responsive

      const measureChunk = () => {
        if (!measurementNode || currentMeasureIndexRef.current >= itemsToMeasureRef.current.length) {
          if (currentMeasureIndexRef.current >= itemsToMeasureRef.current.length) {
            console.log("Measurement Worker: All items measured.");
            // Ensure final itemHeightsRef has all measured heights
            itemHeightsRef.current = { ...measuredHeightsRef.current };
            if (listRef.current) {
              listRef.current.resetAfterIndex(0, false); // Final reset with all new heights
            }
          }
          measurementRequestRef.current = null;
          return;
        }

        const frameStartTime = performance.now();
        let itemsProcessedThisFrame = 0;
        let heightsChangedInChunk = false;

        while (itemsProcessedThisFrame < CHUNK_SIZE && (performance.now() - frameStartTime) < MAX_TIME_PER_CHUNK_MS) {
          if (currentMeasureIndexRef.current >= itemsToMeasureRef.current.length) break;

          const indexToMeasure = currentMeasureIndexRef.current;
          const result = itemsToMeasureRef.current[indexToMeasure];
          const structData = result.document?.structData;
          let cardHtml = '';
          let currentHeight = 0;

          if (!structData) {
            currentHeight = 100; // Default for items without data
          } else {
            const amenitiesHtml = (structData.amenities || [])
              .slice(0, 4)
              .map((amenity: string) => `<span class="amenity-tag">${amenity}</span>`)
              .join('');

            cardHtml = `
              <div class="hotel-card-list-item" style="padding-bottom: 10px;">
                <div class="hotel-card">
                  ${structData.hotel_image ? `<img src="${structData.hotel_image}" alt="" class="hotel-image" style="width: 100px; height: 100px; background-color: #eee;"/>` : '<div class="hotel-image" style="width: 100px; height: 100px; background-color: #eee;"></div>'}
                  <div class="hotel-info">
                    <h4>${structData.hotel_name || 'N/A'}</h4>
                    <p class="hotel-rating">Rating: ${structData.star_rating || 'N/A'} stars</p>
                    ${amenitiesHtml ? `<div class="amenities-tags">${amenitiesHtml}</div>` : ''}
                    <p class="hotel-price">${structData.final_price ? `IDR ${structData.final_price}` : 'Price N/A'}</p>
                  </div>
                </div>
              </div>
            `;
            measurementNode.innerHTML = cardHtml; // This is still the costly part per item
            currentHeight = measurementNode.offsetHeight;
          }
          
          if (measuredHeightsRef.current[indexToMeasure] !== currentHeight) {
            measuredHeightsRef.current[indexToMeasure] = currentHeight;
            // Also update itemHeightsRef incrementally for smoother updates
            if (itemHeightsRef.current[indexToMeasure] !== currentHeight) {
                itemHeightsRef.current[indexToMeasure] = currentHeight;
                heightsChangedInChunk = true;
            }
          }
          currentMeasureIndexRef.current++;
          itemsProcessedThisFrame++;
        }
        
        // If heights changed and were applied to itemHeightsRef, notify react-window
        if (heightsChangedInChunk && listRef.current) {
            // To avoid too many resets, we could be more selective,
            // e.g., only reset if a visible range is affected or batch resets.
            // For now, a general reset is simpler.
            // listRef.current.resetAfterIndex(0, false);
        }

        if (currentMeasureIndexRef.current < itemsToMeasureRef.current.length) {
            measurementRequestRef.current = requestAnimationFrame(measureChunk);
        } else {
            // All items processed, do a final update and reset
            console.log("Measurement Worker: All items measured (finalizing).");
            itemHeightsRef.current = { ...measuredHeightsRef.current };
            if (listRef.current) {
                listRef.current.resetAfterIndex(0, false);
            }
            measurementRequestRef.current = null;
        }
      };

      measurementRequestRef.current = requestAnimationFrame(measureChunk);

    } else if (!hotelResults) { // Handles results becoming null or empty
      if (measurementRequestRef.current) {
        cancelAnimationFrame(measurementRequestRef.current);
        measurementRequestRef.current = null;
      }
      console.log("Measurement Scheduler: hotelResults are null/empty, clearing heights.");
      itemHeightsRef.current = {};
      itemsToMeasureRef.current = [];
      measuredHeightsRef.current = {};
      currentMeasureIndexRef.current = 0;
      if (listRef.current) {
        listRef.current.resetAfterIndex(0, false);
      }
    }

    // Cleanup function for when the component unmounts or hotelResults changes again (triggering effect rerun)
    return () => {
      if (measurementRequestRef.current) {
        cancelAnimationFrame(measurementRequestRef.current);
        measurementRequestRef.current = null;
      }
    };
  }, [hotelResults]); // Dependency: only hotelResults. Refs handle internal state.

  const getItemHeight = useCallback((index: number) => {
    return itemHeightsRef.current[index] || 220; // Default/estimated height if not measured yet
  }, []);

  // HotelCardRow component remains the same
  const HotelCardRow = memo(({ index, style, data }: { index: number; style: React.CSSProperties; data: any[] }) => {
    const result = data[index];
    if (!result) return null;

    return (
      <div style={style} className="hotel-card-list-item"> {/* Apply style here */}
        <div key={result.id} className="hotel-card">
            {/* Image */}
            {result.document?.structData?.hotel_image && (
                <img src={result.document.structData.hotel_image} alt={result.document.structData.hotel_name} className="hotel-image" />
            )}
            {!result.document?.structData?.hotel_image && ( // Placeholder if no image
                <div className="hotel-image" style={{ width: '100px', height: '100px', backgroundColor: '#eee' }}></div>
            )}
            <div className="hotel-info">
                {/* Name */}
                <h4>{result.document?.structData?.hotel_name || 'N/A'}</h4>
                {/* Rating */}
                <p className="hotel-rating">Rating: {result.document?.structData?.star_rating || 'N/A'} stars</p>
                {/* Amenities Tags */}
                {result.document?.structData?.amenities && result.document.structData.amenities.length > 0 && (
                    <div className="amenities-tags">
                        {result.document.structData.amenities.slice(0, 4).map((amenity: string, idx: number) => ( 
                            <span key={idx} className="amenity-tag">{amenity}</span>
                        ))}
                    </div>
                )}
                {/* Price */}
                <p className="hotel-price">{result.document?.structData?.final_price ? `IDR ${result.document.structData.final_price}` : 'Price N/A'}</p>
            </div>
        </div>
      </div>
    );
  });

  // Display configuration error if present
  if (toolConfigError) {
      return <div className="error-message">Configuration Error: {toolConfigError}</div>;
  }

  // FOR DEBUGGING/MEASUREMENT - Render a single sample card
  // const sampleResult = hotelResults && hotelResults.length > 0 ? hotelResults[0] : { // KEEP THIS LINE COMMENTED
  //     id: 'sample1',
  //     document: {
  //         structData: {
  //             hotel_image: 'https://via.placeholder.com/100x100.png?text=Sample+Image',
  //             hotel_name: 'Sample Hotel Name - Very Long To Test Wrapping Behavior of Text if Necessary',
  //             star_rating: '4.5',
  //             amenities: ['Amenity 1', 'Amenity 2', 'Amenity 3', 'Amenity 4', 'Amenity 5'],
  //             final_price: 'IDR 1234567'
  //         }
  //     }
  // };

  // if (hotelResults === null) { // KEEP THIS LINE COMMENTED
  //   // Optionally, show a loading indicator or nothing until results are fetched
  //   // For measurement, we'll force rendering the sample if hotelResults is explicitly null
  //   // but if it's an empty array, it means search returned nothing, so we don't show sample.
  // }


  // Only render the single sample card for measurement IF hotelResults is not an empty array
  // (i.e., search didn't complete with zero results)
  // Or if hotelResults is null (initial state before any search)
  // const shouldShowSampleForMeasurement = (hotelResults === null || (hotelResults && hotelResults.length > 0)); // KEEP THIS LINE COMMENTED

  // Make sure sampleResult is always defined for the measurement block
  // const robustSampleResult = { // KEEP THIS LINE COMMENTED
  //   id: 'sample1',
  //   document: {
  //       structData: {
  //           hotel_image: 'https://via.placeholder.com/100x100.png?text=Sample+Image', // This is a placeholder
  //           hotel_name: 'Sample Hotel Name - Very Long To Test Wrapping Behavior of Text if Necessary',
  //           star_rating: '4.5',
  //           amenities: ['Amenity 1', 'Amenity 2', 'Amenity 3', 'Amenity 4'], // Reduced for consistent height
  //           final_price: 'IDR 1234567'
  //       }
  //   }
  // };

  // if (shouldShowSampleForMeasurement) { // KEEP THIS BLOCK COMMENTED OUT
  //   return (
  //     <div className="hotel-results-container" style={{ border: '2px dashed blue', padding: '15px', margin: '10px' }}>
  //       <h3>Hotel Search Results (Single Card Test for Measurement)</h3>
  //       <p style={{marginTop: '10px', fontSize: '12px', color: 'crimson'}}>
  //           NOTE: This is a temporary view for measuring a single card. Ensure the `hotel-card-list-item`
  //           inside `HotelCardRow` (when used by react-window) has its `padding-bottom: 10px` (from SCSS).
  //           The height of the RED-BORDERED `.hotel-card` below is what we need.
  //           (The placeholder image might appear broken, this is okay for height measurement if it reserves space).
  //       </p>
  //       <div style={{ border: '2px solid red', padding: '5px', marginTop: '5px'}}>
  //        <div className="hotel-card-list-item" style={{ paddingBottom: '10px' }}> {/* Mimic structure that react-window row would have */}
  //           <div className="hotel-card"> {/* THIS IS THE ELEMENT TO MEASURE */}
  //               {robustSampleResult.document?.structData?.hotel_image && (
  //                   <img 
  //                       src={robustSampleResult.document.structData.hotel_image} 
  //                       alt={robustSampleResult.document.structData.hotel_name} 
  //                       className="hotel-image" 
  //                       style={{ width: '100px', height: '100px', backgroundColor: '#eee' }} // Ensure space is reserved for image
  //                   />
  //               )}
  //               <div className="hotel-info">
  //                   <h4>{robustSampleResult.document?.structData?.hotel_name || 'N/A'}</h4>
  //                   <p className="hotel-rating">Rating: {robustSampleResult.document?.structData?.star_rating || 'N/A'} stars</p>
  //                   {robustSampleResult.document?.structData?.amenities && robustSampleResult.document.structData.amenities.length > 0 && (
  //                       <div className="amenities-tags">
  //                           {robustSampleResult.document.structData.amenities.map((amenity: string, idx: number) => (
  //                               <span key={idx} className="amenity-tag">{amenity}</span>
  //                           ))}
  //                       </div>
  //                   )}
  //                   <p className="hotel-price">{robustSampleResult.document?.structData?.final_price ? `${robustSampleResult.document.structData.final_price}` : 'Price N/A'}</p>
  //               </div>
  //           </div>
  //         </div>
  //       </div>
  //     </div>
  //   );
  // }

  // Hidden div for measurements
  const measurementDivStyle: React.CSSProperties = {
    position: 'absolute',
    top: '-9999px',
    left: '-9999px',
    width: '100%', // Should match list item width for accurate height
    visibility: 'hidden',
    pointerEvents: 'none',
    // To ensure accurate measurement, this div should have a constrained width
    // similar to what the actual list items will have.
    // Assuming the list takes roughly the container width minus some padding.
    // This might need adjustment based on your actual layout.
    // For now, let's set a reasonable fixed width that the card might occupy.
    // This width should be similar to the width of .hotel-results-container
    // Forcing a width on the measurement client.
    // Let's try to get this from the list container, or set a sensible default.
    // The list width is '100%' of its parent. The parent is .hotel-results-container
    // Its parent .main-app-area in App.scss might define the effective width.
    // For now, a fixed width might be safer for consistent measurement.
    // The parent .hotel-results-container has padding: 15px
    // A typical card width was measured around 400px by the MCP tool.
    // The measurement node needs a defined width to calculate height correctly for wrapped text.
    // Let's use a width similar to what a card would actually have.
    // The list has width '100%'. Its parent is 'hotel-results-container'.
    // Let's assume the list container itself is around 400-500px wide in the UI.
    // The measurement div width should be similar.
    // altair.scss -> .hotel-results-container has padding, but no explicit width.
    // Let's set a width, e.g. 400px for measurement. Max card width seems to be around this.
    maxWidth: '420px', // Based on earlier tool measurement (400.88px) + some padding
                     // This is CRITICAL for text wrapping to be measured correctly.
  };

  return (
    <>
      <div ref={measurementClientRef} style={measurementDivStyle}></div>

      {/* Existing UI elements would go here if there were any */}
      {hotelResults && hotelResults.length > 0 && (
          <div className="hotel-results-container">
              <h3>Hotel Search Results:</h3>
                {(() => { console.log('Rendering hotelResults with VariableSizeList:', hotelResults.length, 'items'); return null; })()}
              <List
                ref={listRef}
                height={500} // Define a fixed height for the list container
                itemCount={hotelResults.length}
                itemSize={getItemHeight} // Function to get item height
                estimatedItemSize={240} // Increased estimate
                itemData={hotelResults}
                width={'100%'}
              >
                {HotelCardRow}
              </List>
          </div>
      )}
       {hotelResults && hotelResults.length === 0 && (
        <div className="hotel-results-container">
            <h3>Hotel Search Results:</h3>
            <p>No hotels found for your query.</p>
        </div>
      )}
       {toolConfigError && (
          <div className="error-message">Configuration Error: {toolConfigError}</div>
      )}
    </>
  );
}

export const Altair = memo(AltairComponent);
