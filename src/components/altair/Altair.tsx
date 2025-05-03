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
import { useEffect, memo, useState } from "react";
import './altair.scss';
import { useLiveAPIContext } from "../../contexts/LiveAPIContext";
import { ToolCall } from "../../multimodal-live-types";

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
      console.log(`Received tool call:`, toolCall);

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

  // This component no longer renders anything directly.
  // Gemini will handle the response based on the tool results.
  // Display configuration error if present
  if (toolConfigError) {
      return <div className="error-message">Configuration Error: {toolConfigError}</div>;
  }

  return (
    <>
      {/* Existing UI elements would go here if there were any */}
      {hotelResults && hotelResults.length > 0 && (
          <div className="hotel-results-container">
              <h3>Hotel Search Results:</h3>
                {/* Added log 3 - Log and return null to satisfy ReactNode type */}
                {(() => { console.log('Rendering hotelResults:', hotelResults); return null; })()}
              {hotelResults.map((result) => (
                  <div key={result.id} className="hotel-card">
                      {/* Image */}
                      {result.document?.structData?.hotel_image && (
                          <img src={result.document.structData.hotel_image} alt={result.document.structData.hotel_name} className="hotel-image" />
                      )}
                      <div className="hotel-info">
                          {/* Name */}
                          <h4>{result.document?.structData?.hotel_name || 'N/A'}</h4>
                          {/* Rating */}
                          <p className="hotel-rating">Rating: {result.document?.structData?.star_rating || 'N/A'} stars</p>
                          {/* Amenities Tags */}
                          {result.document?.structData?.amenities && result.document.structData.amenities.length > 0 && (
                              <div className="amenities-tags">
                                  {result.document.structData.amenities.slice(0, 4).map((amenity: string, index: number) => ( // Show first 4 amenities
                                      <span key={index} className="amenity-tag">{amenity}</span>
                                  ))}
                              </div>
                          )}
                          {/* Price */}
                          <p className="hotel-price">{result.document?.structData?.final_price ? `IDR ${result.document.structData.final_price}` : 'Price N/A'}</p>
                          {/* Removed: Full Address, Full Description, Full Amenity List */}
                      </div>
                  </div>
              ))}
          </div>
      )}
    </>
  );
}

export const Altair = memo(AltairComponent);
